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

export interface TelegramConfig {
  readonly botToken: string;
  readonly webhookSecret: string;
  readonly allowedUserIds: ReadonlySet<number>;
}

export interface Config {
  readonly port: number;
  readonly nodeEnv: string;
  readonly telegram: TelegramConfig;
  /** Path to the SQLite file backing the audit log. */
  readonly databasePath: string;
}

/** Raised when one or more environment values are missing or malformed. */
export class ConfigError extends Error {
  readonly problems: readonly string[];

  constructor(problems: readonly string[]) {
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

function readRequired(env: NodeJS.ProcessEnv, key: string, problems: string[]): string | null {
  const raw = env[key]?.trim();
  if (!raw) {
    problems.push(`${key} is required but missing or empty`);
    return null;
  }
  return raw;
}

function parseBotToken(env: NodeJS.ProcessEnv, problems: string[]): string {
  const token = readRequired(env, 'TELEGRAM_BOT_TOKEN', problems);
  if (token === null) return '';

  if (!BOT_TOKEN_PATTERN.test(token)) {
    // Never echo the value itself — it is a credential.
    problems.push('TELEGRAM_BOT_TOKEN is not a valid bot token (expected "<id>:<secret>")');
  }
  return token;
}

function parseWebhookSecret(env: NodeJS.ProcessEnv, problems: string[]): string {
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

function parseAllowedUserIds(env: NodeJS.ProcessEnv, problems: string[]): ReadonlySet<number> {
  const raw = readRequired(env, 'TELEGRAM_ALLOWED_USER_IDS', problems);
  if (raw === null) return new Set();

  const ids = new Set<number>();
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

function parseDatabasePath(env: NodeJS.ProcessEnv, problems: string[]): string {
  const raw = env.DATABASE_PATH?.trim();
  if (!raw) return DEFAULT_DATABASE_PATH;

  if (raw.endsWith('/') || raw.endsWith('\\')) {
    problems.push(`DATABASE_PATH must be a file path, not a directory (got "${raw}")`);
  }
  return raw;
}

function parsePort(env: NodeJS.ProcessEnv, problems: string[]): number {
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
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const problems: string[] = [];

  const config: Config = {
    port: parsePort(env, problems),
    nodeEnv: env.NODE_ENV?.trim() || 'development',
    telegram: {
      botToken: parseBotToken(env, problems),
      webhookSecret: parseWebhookSecret(env, problems),
      allowedUserIds: parseAllowedUserIds(env, problems),
    },
    databasePath: parseDatabasePath(env, problems),
  };

  if (problems.length > 0) throw new ConfigError(problems);
  return config;
}
