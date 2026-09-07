/**
 * Anthropic (Claude) client for transaction draft extraction.
 *
 * One provider, one call, one job. The Messages API's tool-use feature does
 * both intent detection and field extraction in a single request: the model
 * is forced (`tool_choice`) to call `record_transaction_draft`, so there is no
 * separate "classify then extract" round trip. `fetch` is injectable, exactly
 * like the Telegram and Tally clients, so no test needs a real API key or
 * network access.
 *
 * This module has no path to Tally and no path to sending anything back to the
 * user — it only turns a message into a validated {@link TransactionDraft}.
 */
import { TRANSACTION_DRAFT_SYSTEM_PROMPT } from './prompts.js';
import { TRANSACTION_DRAFT_TOOL_SCHEMA, parseTransactionDraft } from './schema.js';
const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';
const TOOL_NAME = 'record_transaction_draft';
/** Generous enough for a draft with several line items; extraction is terse. */
const DEFAULT_MAX_TOKENS = 1024;
/** A hung request must not hang the webhook that's waiting on it. */
const DEFAULT_TIMEOUT_MS = 20_000;
/** Network failure, timeout, or a non-2xx HTTP response. Never carries the API key. */
export class LLMConnectionError extends Error {
  constructor(cause) {
    super(
      `Could not reach the Anthropic API: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
    this.name = 'LLMConnectionError';
  }
}
/** The API answered, but not with a usable tool call — a shape problem, not a network one. */
export class LLMResponseError extends Error {
  constructor(message) {
    super(message);
    this.name = 'LLMResponseError';
  }
}
function isToolUseBlock(block) {
  return typeof block === 'object' && block !== null && block.type === 'tool_use';
}
export function createAnthropicClient(options) {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const workspaceId = options.workspaceId?.trim() || null;
  const headers = {
    'content-type': 'application/json',
    'x-api-key': options.apiKey,
    'anthropic-version': ANTHROPIC_VERSION,
    // Omitted entirely when unset — an empty header value is rejected just
    // as a missing one is, so there is no "send it blank" middle ground.
    ...(workspaceId !== null ? { 'anthropic-workspace-id': workspaceId } : {}),
  };
  return {
    async extractTransactionDraft(message) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), timeoutMs);
      let response;
      try {
        response = await fetchImpl(ANTHROPIC_API_URL, {
          method: 'POST',
          headers,
          body: JSON.stringify({
            model: options.model,
            max_tokens: DEFAULT_MAX_TOKENS,
            system: TRANSACTION_DRAFT_SYSTEM_PROMPT,
            messages: [{ role: 'user', content: message }],
            tools: [
              {
                name: TOOL_NAME,
                description:
                  'Record the structured transaction draft extracted from the user message.',
                input_schema: TRANSACTION_DRAFT_TOOL_SCHEMA,
              },
            ],
            // Forces the single combined call: the model must call this tool
            // rather than optionally replying with plain text first.
            tool_choice: { type: 'tool', name: TOOL_NAME },
          }),
          signal: controller.signal,
        });
      } catch (error) {
        throw new LLMConnectionError(error);
      } finally {
        clearTimeout(timeout);
      }
      let body;
      try {
        body = await response.json();
      } catch (error) {
        throw new LLMConnectionError(error);
      }
      if (!response.ok) {
        throw new LLMConnectionError(
          new Error(`HTTP ${response.status}: ${body.error?.message ?? 'unknown error'}`),
        );
      }
      const toolUse = (body.content ?? []).find(
        (block) => isToolUseBlock(block) && block.name === TOOL_NAME,
      );
      if (toolUse === undefined) {
        throw new LLMResponseError(`Anthropic response did not include a ${TOOL_NAME} tool call`);
      }
      // Schema-validated regardless of the forced tool_choice: a model output
      // matching the requested tool signature is not assumed to be correct.
      return parseTransactionDraft(toolUse.input);
    },
  };
}
