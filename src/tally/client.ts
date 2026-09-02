/**
 * Tally HTTP client.
 *
 * Export only. There is no method here that could write to Tally — the
 * project's core rule is that nothing but a user-confirmed, backend-validated
 * voucher post ever reaches Tally, and that arrives in a later phase with its
 * own explicit posting path. `fetch` is injectable so tests never need a
 * running TallyPrime instance.
 */

import { buildCollectionRequest, parseCollectionResponse } from './xml.ts';
import type { RawMasterRecord } from './xml.ts';

export type FetchLike = typeof globalThis.fetch;

/** Tally's HTTP interface is local; a slow or hung instance should fail fast. */
const DEFAULT_TIMEOUT_MS = 10_000;

export class TallyConnectionError extends Error {
  constructor(host: string, port: number, cause: unknown) {
    super(
      `Could not reach TallyPrime at ${host}:${port}. Is TallyPrime running with the company open? (${cause instanceof Error ? cause.message : String(cause)})`,
    );
    this.name = 'TallyConnectionError';
  }
}

export interface TallyClient {
  /**
   * Export one master collection, e.g. `exportCollection('Ledger', ['NAME',
   * 'PARENT'])`. Returns raw string-valued records — see {@link RawMasterRecord}.
   */
  exportCollection(masterType: string, fields: readonly string[]): Promise<RawMasterRecord[]>;
}

export interface TallyClientOptions {
  readonly host: string;
  readonly port: number;
  readonly companyName: string;
  readonly fetchImpl?: FetchLike;
  readonly timeoutMs?: number;
}

export function createTallyClient(options: TallyClientOptions): TallyClient {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const url = `http://${options.host}:${options.port}`;

  return {
    async exportCollection(
      masterType: string,
      fields: readonly string[],
    ): Promise<RawMasterRecord[]> {
      // Distinct per call only to make server-side logs traceable; no
      // significance to Tally itself.
      const collectionName = `TallyTalk_${masterType}_${Date.now()}`;
      const body = buildCollectionRequest({
        collectionName,
        masterType,
        companyName: options.companyName,
        fields,
      });

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), timeoutMs);

      let response: Response;
      try {
        response = await fetchImpl(url, {
          method: 'POST',
          headers: { 'content-type': 'text/xml' },
          body,
          signal: controller.signal,
        });
      } catch (error) {
        throw new TallyConnectionError(options.host, options.port, error);
      } finally {
        clearTimeout(timeout);
      }

      if (!response.ok) {
        throw new TallyConnectionError(
          options.host,
          options.port,
          new Error(`HTTP ${response.status}`),
        );
      }

      // Confirmed live: TallyPrime's HTTP export responds in plain UTF-8, unlike
      // its UTF-16LE file exports — text() decodes correctly without help.
      const xml = await response.text();
      return parseCollectionResponse(xml, masterType.toUpperCase());
    },
  };
}
