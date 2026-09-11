/**
 * Environment configuration loading and startup validation.
 *
 * Every value the running process depends on is read and validated here, once,
 * before the server starts listening. A misconfigured deployment fails loudly
 * at boot rather than at the first webhook request.
 *
 * Only Phase 1 keys are validated. LLM and Tally settings are documented in
 * `.env.example` but are not required until the phases that use them.
 */
import { isRecognizedState } from '../gst/states.js';
/** Raised when one or more environment values are missing or malformed. */
export class ConfigError extends Error {
  problems;
  constructor(problems) {
    super(`Invalid environment configuration:\n${problems.map((p) => `  - ${p}`).join('\n')}`);
    this.name = 'ConfigError';
    this.problems = problems;
  }
}
const MIN_WEBHOOK_SECRET_LENGTH = 16;
const MAX_WEBHOOK_SECRET_LENGTH = 256;
/** Telegram restricts the webhook secret to these characters. */
const WEBHOOK_SECRET_PATTERN = /^[A-Za-z0-9_-]+$/;
/** Bot tokens look like `123456789:AA...`. Catches pasted placeholders. */
const BOT_TOKEN_PATTERN = /^\d+:[A-Za-z0-9_-]{30,}$/;
function readRequired(env, key, problems) {
  const raw = env[key]?.trim();
  if (!raw) {
    problems.push(`${key} is required but missing or empty`);
    return null;
  }
  return raw;
}
function parseBotToken(env, problems) {
  const token = readRequired(env, 'TELEGRAM_BOT_TOKEN', problems);
  if (token === null) return '';
  if (!BOT_TOKEN_PATTERN.test(token)) {
    // Never echo the value itself — it is a credential.
    problems.push('TELEGRAM_BOT_TOKEN is not a valid bot token (expected "<id>:<secret>")');
  }
  return token;
}
function parseWebhookSecret(env, problems) {
  const secret = readRequired(env, 'TELEGRAM_WEBHOOK_SECRET', problems);
  if (secret === null) return '';
  if (secret.length < MIN_WEBHOOK_SECRET_LENGTH) {
    problems.push(
      `TELEGRAM_WEBHOOK_SECRET must be at least ${MIN_WEBHOOK_SECRET_LENGTH} characters`,
    );
  } else if (secret.length > MAX_WEBHOOK_SECRET_LENGTH) {
    problems.push(
      `TELEGRAM_WEBHOOK_SECRET must be at most ${MAX_WEBHOOK_SECRET_LENGTH} characters`,
    );
  }
  if (!WEBHOOK_SECRET_PATTERN.test(secret)) {
    problems.push('TELEGRAM_WEBHOOK_SECRET may only contain A-Z, a-z, 0-9, underscore and hyphen');
  }
  return secret;
}
function parseAllowedUserIds(env, problems) {
  const raw = readRequired(env, 'TELEGRAM_ALLOWED_USER_IDS', problems);
  if (raw === null) return new Set();
  const ids = new Set();
  for (const entry of raw.split(',')) {
    const candidate = entry.trim();
    if (candidate === '') continue;
    const id = Number(candidate);
    if (!Number.isSafeInteger(id) || id <= 0) {
      problems.push(
        `TELEGRAM_ALLOWED_USER_IDS contains "${candidate}", which is not a positive integer`,
      );
      continue;
    }
    ids.add(id);
  }
  if (ids.size === 0 && !problems.some((p) => p.startsWith('TELEGRAM_ALLOWED_USER_IDS'))) {
    problems.push('TELEGRAM_ALLOWED_USER_IDS must list at least one Telegram user ID');
  }
  return ids;
}
const DEFAULT_DATABASE_PATH = './data/tallytalk.sqlite';
function parseDatabasePath(env, problems) {
  const raw = env.DATABASE_PATH?.trim();
  if (!raw) return DEFAULT_DATABASE_PATH;
  if (raw.endsWith('/') || raw.endsWith('\\')) {
    problems.push(`DATABASE_PATH must be a file path, not a directory (got "${raw}")`);
  }
  return raw;
}
const DEFAULT_TALLY_HOST = '127.0.0.1';
const DEFAULT_TALLY_PORT = 9000;
/**
 * `companyName` is deliberately absent here — it is discovered dynamically
 * from Tally itself (`tally/company.js`), never a hardcoded/required env
 * value. Callers that need it read it from the discovered company, not from
 * this config object.
 */
function parseTally(env, problems) {
  const host = env.TALLY_HOST?.trim() || DEFAULT_TALLY_HOST;
  let port = DEFAULT_TALLY_PORT;
  const rawPort = env.TALLY_PORT?.trim();
  if (rawPort) {
    const parsed = Number(rawPort);
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
      problems.push(`TALLY_PORT must be an integer between 1 and 65535 (got "${rawPort}")`);
    } else {
      port = parsed;
    }
  }
  return { host, port };
}
const DEFAULT_LLM_MODEL = 'claude-sonnet-5';
function parseLLM(env, problems) {
  const rawProvider = env.LLM_PROVIDER?.trim() || 'anthropic';
  if (rawProvider !== 'anthropic') {
    problems.push(
      `LLM_PROVIDER must be "anthropic" (got "${rawProvider}") — no other provider is implemented`,
    );
  }
  const apiKey = readRequired(env, 'LLM_API_KEY', problems) ?? '';
  const model = env.LLM_MODEL?.trim() || DEFAULT_LLM_MODEL;
  // Optional: only an identity-linked key needs it, so an unset or blank
  // value is a normal configuration, not a problem to report.
  const workspaceId = env.ANTHROPIC_WORKSPACE_ID?.trim() || null;
  return { provider: 'anthropic', apiKey, model, workspaceId };
}
/**
 * `companyState` and the three GST ledger names are deliberately absent
 * here: company state is discovered from Tally (`tally/company.js`), and
 * CGST/SGST/IGST ledgers are resolved dynamically per transaction from
 * `TAXTYPE`/`GSTDUTYHEAD` on the cached Ledger masters
 * (`gst/gstLedgerResolution.js`) — none of these are configuration this
 * project asks an operator to hardcode per client. `defaultPlaceOfSupply`
 * stays: Place of Supply is a transaction fact with no Tally master source at
 * all (confirmed by investigation), so an explicit default remains the only
 * safe non-Tally-derived option, and only when an operator deliberately
 * configures one.
 */
function parseGst(env, problems) {
  const rawDefault = env.DEFAULT_PLACE_OF_SUPPLY?.trim() || null;
  if (rawDefault !== null && !isRecognizedState(rawDefault)) {
    problems.push(
      `DEFAULT_PLACE_OF_SUPPLY "${rawDefault}" is not a recognised Indian state or union territory`,
    );
  }
  return { defaultPlaceOfSupply: rawDefault };
}
/**
 * Unlike `DEFAULT_PLACE_OF_SUPPLY`, there is no static reference list a
 * godown name can be checked against here — Tally's Godown master is the
 * only source of truth, and it isn't synced yet at config-load time. This
 * just captures the configured value as-is; `checkPostingReadiness`
 * (`gst/postingReadiness.js`) resolves it against the live cache on every
 * request and blocks with `godown_not_found_in_masters` if it's wrong,
 * exactly like an explicitly stated godown that doesn't exist.
 */
function parseGodown(env) {
  return { defaultGodown: env.DEFAULT_GODOWN?.trim() || null };
}
function parsePort(env, problems) {
  const raw = env.PORT?.trim();
  if (!raw) return 3000;
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    problems.push(`PORT must be an integer between 1 and 65535 (got "${raw}")`);
    return 3000;
  }
  return port;
}
/**
 * Build the validated configuration, or throw {@link ConfigError} listing every
 * problem found. All problems are collected in one pass so a misconfigured
 * deployment can be fixed in a single edit.
 */
export function loadConfig(env = process.env) {
  const problems = [];
  const config = {
    port: parsePort(env, problems),
    nodeEnv: env.NODE_ENV?.trim() || 'development',
    telegram: {
      botToken: parseBotToken(env, problems),
      webhookSecret: parseWebhookSecret(env, problems),
      allowedUserIds: parseAllowedUserIds(env, problems),
    },
    databasePath: parseDatabasePath(env, problems),
    tally: parseTally(env, problems),
    llm: parseLLM(env, problems),
    gst: parseGst(env, problems),
    godown: parseGodown(env),
  };
  if (problems.length > 0) throw new ConfigError(problems);
  return config;
}
