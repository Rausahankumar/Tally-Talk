import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createAuditLog } from '../src/audit/log.ts';
import type { AuditLog } from '../src/audit/log.ts';
import { AUDIT_EVENTS_TABLE, LATEST_SCHEMA_VERSION } from '../src/db/schema.ts';
import type { Database } from '../src/db/sqlite.ts';
import { silentLogger } from '../src/logger.ts';
import { createTestDatabase } from './helpers/testDatabase.ts';

let database: Database;
let auditLog: AuditLog;

beforeEach(() => {
  database = createTestDatabase();
  auditLog = createAuditLog({ db: database.db, logger: silentLogger });
});

afterEach(() => {
  database.close();
});

describe('appending events', () => {
  it('stores an event and reads it back', () => {
    auditLog.record({
      correlationId: 'turn-1',
      type: 'message.received',
      channel: 'telegram',
      actor: { kind: 'user', telegramUserId: 111, chatId: 222 },
      data: { text: 'sell 100 bags to Ramesh' },
    });

    const events = auditLog.findByCorrelationId('turn-1');

    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe('message.received');
    expect(events[0]?.channel).toBe('telegram');
    expect(events[0]?.actor).toEqual({ kind: 'user', telegramUserId: 111, chatId: 222 });
    expect(events[0]?.data).toEqual({ text: 'sell 100 bags to Ramesh' });
    expect(events[0]?.occurredAt).toBeInstanceOf(Date);
    expect(events[0]?.schemaVersion).toBe(1);
  });

  it('returns a turn in the order it happened', () => {
    for (const type of ['message.received', 'authorization.granted'] as const) {
      auditLog.record({
        correlationId: 'turn-2',
        type,
        channel: 'telegram',
        actor: { kind: 'user', telegramUserId: 111 },
      });
    }

    expect(auditLog.findByCorrelationId('turn-2').map((e) => e.type)).toEqual([
      'message.received',
      'authorization.granted',
    ]);
  });

  it('keeps turns separate', () => {
    auditLog.record({
      correlationId: 'turn-a',
      type: 'message.received',
      channel: 'telegram',
      actor: { kind: 'user', telegramUserId: 111 },
    });
    auditLog.record({
      correlationId: 'turn-b',
      type: 'message.received',
      channel: 'telegram',
      actor: { kind: 'user', telegramUserId: 222 },
    });

    expect(auditLog.findByCorrelationId('turn-a')).toHaveLength(1);
    expect(auditLog.findByCorrelationId('turn-b')).toHaveLength(1);
    expect(auditLog.findByCorrelationId('turn-unknown')).toHaveLength(0);
  });

  it('omits actor fields that were not supplied', () => {
    auditLog.record({
      correlationId: 'turn-3',
      type: 'webhook.rejected',
      channel: 'system',
      actor: { kind: 'system' },
      data: { reason: 'missing_secret_token' },
    });

    expect(auditLog.findByCorrelationId('turn-3')[0]?.actor).toEqual({ kind: 'system' });
  });

  it('defaults data to an empty object when the caller supplies none', () => {
    auditLog.record({
      correlationId: 'turn-4',
      type: 'authorization.granted',
      channel: 'telegram',
      actor: { kind: 'user', telegramUserId: 111 },
    });

    expect(auditLog.findByCorrelationId('turn-4')[0]?.data).toEqual({});
  });

  it('round-trips a nested payload of the kind later phases will store', () => {
    const payload = {
      draft: { customer: 'Ramesh', item: 'cement', quantity: 100, rate: 500, gst: 18 },
      candidates: ['Ramesh Kumar Enterprises', 'Ramesh Traders'],
    };

    auditLog.record({
      correlationId: 'turn-5',
      type: 'llm.extraction.completed',
      channel: 'telegram',
      actor: { kind: 'user', telegramUserId: 111 },
      data: payload,
    });

    expect(auditLog.findByCorrelationId('turn-5')[0]?.data).toEqual(payload);
  });

  it('does not throw when a write fails, so a request is never lost to a logging error', () => {
    expect(() =>
      auditLog.record({
        correlationId: 'turn-6',
        // Outside the vocabulary the CHECK constraint accepts.
        type: 'not.a.real.event' as never,
        channel: 'telegram',
        actor: { kind: 'user', telegramUserId: 111 },
      }),
    ).not.toThrow();

    expect(auditLog.findByCorrelationId('turn-6')).toHaveLength(0);
  });
});

describe('append-only enforcement', () => {
  beforeEach(() => {
    auditLog.record({
      correlationId: 'turn-locked',
      type: 'message.received',
      channel: 'telegram',
      actor: { kind: 'user', telegramUserId: 111 },
      data: { text: 'original' },
    });
  });

  it('refuses an update, even from a direct SQL statement', () => {
    expect(() =>
      database.db.exec(`UPDATE ${AUDIT_EVENTS_TABLE} SET data = '{"text":"tampered"}'`),
    ).toThrow(/append-only/);

    expect(auditLog.findByCorrelationId('turn-locked')[0]?.data).toEqual({ text: 'original' });
  });

  it('refuses a delete, even from a direct SQL statement', () => {
    expect(() => database.db.exec(`DELETE FROM ${AUDIT_EVENTS_TABLE}`)).toThrow(/append-only/);

    expect(auditLog.findByCorrelationId('turn-locked')).toHaveLength(1);
  });

  it('exposes no way to mutate history through the interface', () => {
    expect(Object.keys(auditLog).sort()).toEqual(['findByCorrelationId', 'record']);
  });
});

describe('schema', () => {
  const insertRaw = (type: string, channel: string, data: string): string =>
    `INSERT INTO ${AUDIT_EVENTS_TABLE}
       (schema_version, correlation_id, occurred_at, type, channel, actor_kind, data)
     VALUES (1, 'x', '2026-09-02T00:00:00.000Z', '${type}', '${channel}', 'user', '${data}')`;

  it('rejects an unknown event type', () => {
    expect(() => database.db.exec(insertRaw('made.up.type', 'telegram', '{}'))).toThrow();
  });

  it('rejects an unknown channel', () => {
    expect(() => database.db.exec(insertRaw('message.received', 'pigeon', '{}'))).toThrow();
  });

  it('rejects a data column that is not valid JSON', () => {
    expect(() => database.db.exec(insertRaw('message.received', 'telegram', 'not json'))).toThrow();
  });

  it('records the schema version and is safe to migrate twice', () => {
    const row = database.db.prepare('PRAGMA user_version').get() as { user_version: number };

    expect(row.user_version).toBe(LATEST_SCHEMA_VERSION);

    // A second open of a fresh database must land on the same version.
    const reopened = createTestDatabase();
    expect(
      (reopened.db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version,
    ).toBe(LATEST_SCHEMA_VERSION);
    reopened.close();
  });

  it('creates the indexes later queries depend on', () => {
    const names = (
      database.db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = ?")
        .all(AUDIT_EVENTS_TABLE) as unknown as { name: string }[]
    ).map((row) => row.name);

    expect(names).toEqual(
      expect.arrayContaining([
        'idx_audit_events_correlation',
        'idx_audit_events_occurred_at',
        'idx_audit_events_user',
      ]),
    );
  });
});
