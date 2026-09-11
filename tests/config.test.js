import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from '../src/config/index.js';
const VALID_TOKEN = '123456789:AAEEabcdefghijklmnopqrstuvwxyz0123456';
const VALID_SECRET = 'a-webhook-secret-value';
function validEnv(overrides = {}) {
  return {
    TELEGRAM_BOT_TOKEN: VALID_TOKEN,
    TELEGRAM_WEBHOOK_SECRET: VALID_SECRET,
    TELEGRAM_ALLOWED_USER_IDS: '111,222',
    LLM_API_KEY: 'sk-ant-test-key-not-real',
    ...overrides,
  };
}
function problemsFrom(env) {
  try {
    loadConfig(env);
  } catch (error) {
    if (error instanceof ConfigError) return error.problems;
    throw error;
  }
  throw new Error('expected loadConfig to throw');
}
describe('loadConfig', () => {
  it('parses a valid environment', () => {
    const config = loadConfig(validEnv({ PORT: '8080', NODE_ENV: 'production' }));
    expect(config.port).toBe(8080);
    expect(config.nodeEnv).toBe('production');
    expect(config.telegram.botToken).toBe(VALID_TOKEN);
    expect(config.telegram.webhookSecret).toBe(VALID_SECRET);
    expect([...config.telegram.allowedUserIds]).toEqual([111, 222]);
  });
  it('defaults port and environment when unset', () => {
    const config = loadConfig(validEnv());
    expect(config.port).toBe(3000);
    expect(config.nodeEnv).toBe('development');
  });
  it('reports every missing required key at once', () => {
    const problems = problemsFrom({});
    expect(problems).toHaveLength(4);
    expect(problems.join('\n')).toContain('TELEGRAM_BOT_TOKEN');
    expect(problems.join('\n')).toContain('TELEGRAM_WEBHOOK_SECRET');
    expect(problems.join('\n')).toContain('TELEGRAM_ALLOWED_USER_IDS');
    expect(problems.join('\n')).toContain('LLM_API_KEY');
  });
  it('treats whitespace-only values as missing', () => {
    const problems = problemsFrom(validEnv({ TELEGRAM_BOT_TOKEN: '   ' }));
    expect(problems.join('\n')).toContain('TELEGRAM_BOT_TOKEN is required');
  });
  it('rejects a malformed bot token without echoing it', () => {
    const problems = problemsFrom(validEnv({ TELEGRAM_BOT_TOKEN: 'not-a-real-token' }));
    expect(problems.join('\n')).toContain('not a valid bot token');
    expect(problems.join('\n')).not.toContain('not-a-real-token');
  });
  it('rejects a webhook secret that is too short to resist guessing', () => {
    const problems = problemsFrom(validEnv({ TELEGRAM_WEBHOOK_SECRET: 'short' }));
    expect(problems.join('\n')).toContain('at least 16 characters');
  });
  it('rejects webhook secret characters Telegram will not accept', () => {
    const problems = problemsFrom(validEnv({ TELEGRAM_WEBHOOK_SECRET: 'has spaces and $igns!' }));
    expect(problems.join('\n')).toContain('may only contain');
  });
  it('rejects non-numeric entries in the allowlist', () => {
    const problems = problemsFrom(validEnv({ TELEGRAM_ALLOWED_USER_IDS: '111,abc' }));
    expect(problems.join('\n')).toContain('"abc"');
  });
  it('rejects a non-positive user id', () => {
    const problems = problemsFrom(validEnv({ TELEGRAM_ALLOWED_USER_IDS: '0' }));
    expect(problems.join('\n')).toContain('"0"');
  });
  it('rejects an allowlist with no usable ids', () => {
    const problems = problemsFrom(validEnv({ TELEGRAM_ALLOWED_USER_IDS: ' , , ' }));
    expect(problems.join('\n')).toContain('at least one Telegram user ID');
  });
  it('tolerates spacing around allowlist entries', () => {
    const config = loadConfig(validEnv({ TELEGRAM_ALLOWED_USER_IDS: ' 111 , 222 ,333' }));
    expect([...config.telegram.allowedUserIds]).toEqual([111, 222, 333]);
  });
  it('defaults the database path', () => {
    expect(loadConfig(validEnv()).databasePath).toBe('./data/tallytalk.sqlite');
  });
  it('accepts an explicit database path', () => {
    expect(loadConfig(validEnv({ DATABASE_PATH: 'D:/data/audit.sqlite' })).databasePath).toBe(
      'D:/data/audit.sqlite',
    );
  });
  it('rejects a database path that names a directory', () => {
    expect(problemsFrom(validEnv({ DATABASE_PATH: './data/' })).join('\n')).toContain(
      'must be a file path',
    );
  });
  it('rejects an out-of-range port', () => {
    expect(problemsFrom(validEnv({ PORT: '70000' })).join('\n')).toContain('between 1 and 65535');
    expect(problemsFrom(validEnv({ PORT: 'abc' })).join('\n')).toContain('between 1 and 65535');
  });
  it('defaults the Tally host and port', () => {
    const config = loadConfig(validEnv());
    expect(config.tally.host).toBe('127.0.0.1');
    expect(config.tally.port).toBe(9000);
  });
  it('reads an explicit Tally host and port', () => {
    const config = loadConfig(validEnv({ TALLY_HOST: '10.0.0.5', TALLY_PORT: '9999' }));
    expect(config.tally.host).toBe('10.0.0.5');
    expect(config.tally.port).toBe(9999);
  });
  it('does not require or read a company name — it is discovered from Tally itself (tally/company.js), never hardcoded', () => {
    const config = loadConfig(validEnv({ TALLY_COMPANY_NAME: 'Should be ignored' }));
    expect(config.tally.companyName).toBeUndefined();
  });
  it('rejects an out-of-range Tally port', () => {
    expect(problemsFrom(validEnv({ TALLY_PORT: '99999' })).join('\n')).toContain('TALLY_PORT');
  });
  it('defaults the LLM provider and model', () => {
    const config = loadConfig(validEnv());
    expect(config.llm.provider).toBe('anthropic');
    expect(config.llm.model).toBe('claude-sonnet-5');
  });
  it('reads an explicit LLM model', () => {
    expect(loadConfig(validEnv({ LLM_MODEL: 'claude-opus-5' })).llm.model).toBe('claude-opus-5');
  });
  it('defaults to no Anthropic workspace id when unset', () => {
    expect(loadConfig(validEnv()).llm.workspaceId).toBeNull();
  });
  it('reads an explicitly configured ANTHROPIC_WORKSPACE_ID', () => {
    expect(loadConfig(validEnv({ ANTHROPIC_WORKSPACE_ID: 'wrkspc_test123' })).llm.workspaceId).toBe(
      'wrkspc_test123',
    );
  });
  it('treats a whitespace-only ANTHROPIC_WORKSPACE_ID as unset rather than a problem', () => {
    // Optional: an identity-linked key needs it, a normal workspace key does
    // not, so a blank value must not fail startup.
    expect(loadConfig(validEnv({ ANTHROPIC_WORKSPACE_ID: '   ' })).llm.workspaceId).toBeNull();
  });
  it('requires an LLM API key', () => {
    expect(problemsFrom(validEnv({ LLM_API_KEY: '' })).join('\n')).toContain(
      'LLM_API_KEY is required',
    );
  });
  it('rejects a provider other than anthropic, since none other is implemented', () => {
    expect(problemsFrom(validEnv({ LLM_PROVIDER: 'openai' })).join('\n')).toContain(
      'LLM_PROVIDER must be "anthropic"',
    );
  });
  it('does not require or read company state, or CGST/SGST/IGST ledger names — company state is discovered from Tally, and GST ledgers are resolved dynamically from TAXTYPE/GSTDUTYHEAD (gst/gstLedgerResolution.js), never hardcoded', () => {
    const config = loadConfig(
      validEnv({ COMPANY_STATE: 'Should be ignored', CGST_LEDGER: 'Should be ignored' }),
    );
    expect(config.gst).toEqual({ defaultPlaceOfSupply: null });
  });
  it('accepts an explicitly configured DEFAULT_PLACE_OF_SUPPLY', () => {
    const config = loadConfig(validEnv({ DEFAULT_PLACE_OF_SUPPLY: 'Uttar Pradesh' }));
    expect(config.gst.defaultPlaceOfSupply).toBe('Uttar Pradesh');
  });
  it('defaults to no Place of Supply default when unset', () => {
    expect(loadConfig(validEnv()).gst.defaultPlaceOfSupply).toBeNull();
  });
  it('rejects an unrecognised DEFAULT_PLACE_OF_SUPPLY', () => {
    expect(problemsFrom(validEnv({ DEFAULT_PLACE_OF_SUPPLY: 'Narnia' })).join('\n')).toContain(
      'not a recognised Indian state',
    );
  });
  it('does not require or read DEFAULT_GODOWN — the existing stock-availability-based auto-select/ask/fail-closed resolution (postingReadiness.js) already covers this', () => {
    const config = loadConfig(validEnv({ DEFAULT_GODOWN: 'Should be ignored' }));
    expect(config.godown).toBeUndefined();
  });
  it('defaults to no PUBLIC_WEBHOOK_URL when unset — local dev keeps registering the webhook by hand', () => {
    expect(loadConfig(validEnv()).telegram.publicWebhookUrl).toBeNull();
  });
  it('accepts a valid PUBLIC_WEBHOOK_URL', () => {
    const config = loadConfig(validEnv({ PUBLIC_WEBHOOK_URL: 'https://tallytalk.example.com' }));
    expect(config.telegram.publicWebhookUrl).toBe('https://tallytalk.example.com');
  });
  it('rejects a PUBLIC_WEBHOOK_URL that is not https://', () => {
    expect(
      problemsFrom(validEnv({ PUBLIC_WEBHOOK_URL: 'http://tallytalk.example.com' })).join('\n'),
    ).toContain('must start with https://');
  });
  it('rejects a PUBLIC_WEBHOOK_URL with a trailing slash', () => {
    expect(
      problemsFrom(validEnv({ PUBLIC_WEBHOOK_URL: 'https://tallytalk.example.com/' })).join('\n'),
    ).toContain('must not end with a trailing slash');
  });
});
