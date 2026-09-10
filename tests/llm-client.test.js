import { describe, expect, it, vi } from 'vitest';
import { LLMConnectionError, LLMResponseError, createAnthropicClient } from '../src/llm/client.js';
import { DraftValidationError } from '../src/llm/schema.js';
const VALID_DRAFT_INPUT = {
  voucherType: 'sales',
  partyName: 'Ramesh',
  items: [{ itemName: 'cement', quantity: 100, rate: 500, godown: null }],
  gstPercent: 18,
  placeOfSupply: null,
  date: null,
  missingFields: [],
  ambiguityNote: null,
};
/** A realistic Anthropic Messages API success response, forced tool_choice shape. */
function anthropicToolResponse(input) {
  return {
    id: 'msg_test123',
    type: 'message',
    role: 'assistant',
    model: 'claude-sonnet-5',
    content: [
      {
        type: 'tool_use',
        id: 'toolu_test123',
        name: 'record_transaction_draft',
        input,
      },
    ],
    stop_reason: 'tool_use',
    stop_sequence: null,
    usage: { input_tokens: 200, output_tokens: 60 },
  };
}
function fakeFetch(status, body) {
  return vi.fn(async () => new Response(JSON.stringify(body), { status }));
}
describe('createAnthropicClient request shape', () => {
  it('sends the message, forced tool choice, and required headers - never a real network call', async () => {
    const fetchImpl = fakeFetch(200, anthropicToolResponse(VALID_DRAFT_INPUT));
    const client = createAnthropicClient({
      apiKey: 'sk-ant-test-key-not-real',
      model: 'claude-sonnet-5',
      fetchImpl,
    });
    await client.extractTransactionDraft('Sell 100 cement bags to Ramesh at 500 each, 18% GST');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe('https://api.anthropic.com/v1/messages');
    expect(init.method).toBe('POST');
    expect(init.headers['x-api-key']).toBe('sk-ant-test-key-not-real');
    expect(init.headers['anthropic-version']).toBe('2023-06-01');
    const payload = JSON.parse(String(init.body));
    expect(payload.model).toBe('claude-sonnet-5');
    expect(payload.tool_choice).toEqual({ type: 'tool', name: 'record_transaction_draft' });
    expect(payload.tools[0].name).toBe('record_transaction_draft');
    expect(payload.messages).toEqual([
      { role: 'user', content: 'Sell 100 cement bags to Ramesh at 500 each, 18% GST' },
    ]);
    expect(typeof payload.system).toBe('string');
    expect(payload.system.length).toBeGreaterThan(0);
  });
  it('omits the anthropic-workspace-id header entirely when no workspace id is configured', async () => {
    const fetchImpl = fakeFetch(200, anthropicToolResponse(VALID_DRAFT_INPUT));
    const client = createAnthropicClient({
      apiKey: 'sk-ant-test-key-not-real',
      model: 'claude-sonnet-5',
      fetchImpl,
    });
    await client.extractTransactionDraft('anything');
    const [, init] = fetchImpl.mock.calls[0];
    const headers = init.headers;
    // Not present at all — not sent blank, which the API rejects the same way.
    expect(Object.keys(headers)).not.toContain('anthropic-workspace-id');
  });
  it('sends anthropic-workspace-id when a workspace id is configured, leaving other headers unchanged', async () => {
    const fetchImpl = fakeFetch(200, anthropicToolResponse(VALID_DRAFT_INPUT));
    const client = createAnthropicClient({
      apiKey: 'sk-ant-test-key-not-real',
      model: 'claude-sonnet-5',
      workspaceId: 'wrkspc_test123',
      fetchImpl,
    });
    await client.extractTransactionDraft('anything');
    const [, init] = fetchImpl.mock.calls[0];
    const headers = init.headers;
    expect(headers['anthropic-workspace-id']).toBe('wrkspc_test123');
    expect(headers['x-api-key']).toBe('sk-ant-test-key-not-real');
    expect(headers['anthropic-version']).toBe('2023-06-01');
    expect(headers['content-type']).toBe('application/json');
  });
  it('treats a blank workspace id as unset rather than sending an empty header', async () => {
    const fetchImpl = fakeFetch(200, anthropicToolResponse(VALID_DRAFT_INPUT));
    const client = createAnthropicClient({
      apiKey: 'sk-ant-test-key-not-real',
      model: 'claude-sonnet-5',
      workspaceId: '   ',
      fetchImpl,
    });
    await client.extractTransactionDraft('anything');
    const [, init] = fetchImpl.mock.calls[0];
    expect(Object.keys(init.headers)).not.toContain('anthropic-workspace-id');
  });
  it('extracts the same draft whether or not a workspace id is configured', async () => {
    const withoutWorkspace = await createAnthropicClient({
      apiKey: 'test',
      model: 'claude-sonnet-5',
      fetchImpl: fakeFetch(200, anthropicToolResponse(VALID_DRAFT_INPUT)),
    }).extractTransactionDraft('Sell 100 cement bags to Ramesh');
    const withWorkspace = await createAnthropicClient({
      apiKey: 'test',
      model: 'claude-sonnet-5',
      workspaceId: 'wrkspc_test123',
      fetchImpl: fakeFetch(200, anthropicToolResponse(VALID_DRAFT_INPUT)),
    }).extractTransactionDraft('Sell 100 cement bags to Ramesh');
    expect(withWorkspace).toEqual(withoutWorkspace);
    expect(withWorkspace).toEqual(VALID_DRAFT_INPUT);
  });
  it('never calls the real Anthropic API - a live key would still hit the injected fetch only', async () => {
    const fetchImpl = fakeFetch(200, anthropicToolResponse(VALID_DRAFT_INPUT));
    const client = createAnthropicClient({ apiKey: 'unused', model: 'claude-sonnet-5', fetchImpl });
    await client.extractTransactionDraft('anything');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
describe('createAnthropicClient successful extraction', () => {
  it('returns a validated draft built from the tool_use input', async () => {
    const client = createAnthropicClient({
      apiKey: 'test',
      model: 'claude-sonnet-5',
      fetchImpl: fakeFetch(200, anthropicToolResponse(VALID_DRAFT_INPUT)),
    });
    const draft = await client.extractTransactionDraft('Sell 100 cement bags to Ramesh');
    expect(draft).toEqual(VALID_DRAFT_INPUT);
  });
  it('finds the tool_use block even if it is not the first content block', async () => {
    const response = anthropicToolResponse(VALID_DRAFT_INPUT);
    response.content = [{ type: 'text', text: 'ignored' }, ...response.content];
    const client = createAnthropicClient({
      apiKey: 'test',
      model: 'claude-sonnet-5',
      fetchImpl: fakeFetch(200, response),
    });
    const draft = await client.extractTransactionDraft('anything');
    expect(draft.partyName).toBe('Ramesh');
  });
});
describe('createAnthropicClient error handling', () => {
  it('wraps a network failure in LLMConnectionError without leaking the API key', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('ECONNREFUSED');
    });
    const client = createAnthropicClient({ apiKey: 'sk-ant-super-secret', model: 'x', fetchImpl });
    await expect(client.extractTransactionDraft('hi')).rejects.toThrow(LLMConnectionError);
    try {
      await client.extractTransactionDraft('hi');
    } catch (error) {
      expect(String(error)).not.toContain('sk-ant-super-secret');
    }
  });
  it('wraps a non-2xx HTTP response in LLMConnectionError', async () => {
    const client = createAnthropicClient({
      apiKey: 'test',
      model: 'claude-sonnet-5',
      fetchImpl: fakeFetch(401, {
        type: 'error',
        error: { type: 'authentication_error', message: 'invalid x-api-key' },
      }),
    });
    await expect(client.extractTransactionDraft('hi')).rejects.toThrow(LLMConnectionError);
    await expect(client.extractTransactionDraft('hi')).rejects.toThrow(/401/);
  });
  it('wraps a 529 overloaded response the same way as any other failure', async () => {
    const client = createAnthropicClient({
      apiKey: 'test',
      model: 'claude-sonnet-5',
      fetchImpl: fakeFetch(529, {
        type: 'error',
        error: { type: 'overloaded_error', message: 'Overloaded' },
      }),
    });
    await expect(client.extractTransactionDraft('hi')).rejects.toThrow(LLMConnectionError);
  });
  it('throws LLMResponseError when the response has no tool_use block', async () => {
    const client = createAnthropicClient({
      apiKey: 'test',
      model: 'claude-sonnet-5',
      fetchImpl: fakeFetch(200, {
        content: [{ type: 'text', text: 'I cannot help with that.' }],
        stop_reason: 'end_turn',
      }),
    });
    await expect(client.extractTransactionDraft('hi')).rejects.toThrow(LLMResponseError);
  });
  it('throws LLMResponseError when content is missing entirely', async () => {
    const client = createAnthropicClient({
      apiKey: 'test',
      model: 'claude-sonnet-5',
      fetchImpl: fakeFetch(200, {}),
    });
    await expect(client.extractTransactionDraft('hi')).rejects.toThrow(LLMResponseError);
  });
  it('does not swallow a malformed body as JSON', async () => {
    const fetchImpl = vi.fn(async () => new Response('not json at all', { status: 200 }));
    const client = createAnthropicClient({ apiKey: 'test', model: 'claude-sonnet-5', fetchImpl });
    await expect(client.extractTransactionDraft('hi')).rejects.toThrow(LLMConnectionError);
  });
  it('propagates DraftValidationError when the tool input does not match the schema', async () => {
    const client = createAnthropicClient({
      apiKey: 'test',
      model: 'claude-sonnet-5',
      fetchImpl: fakeFetch(200, anthropicToolResponse({ voucherType: 'not-a-real-type' })),
    });
    await expect(client.extractTransactionDraft('hi')).rejects.toThrow(DraftValidationError);
  });
  it('aborts after the configured timeout rather than hanging the caller', async () => {
    const fetchImpl = vi.fn(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
        }),
    );
    const client = createAnthropicClient({
      apiKey: 'test',
      model: 'claude-sonnet-5',
      fetchImpl,
      timeoutMs: 20,
    });
    await expect(client.extractTransactionDraft('hi')).rejects.toThrow(LLMConnectionError);
  });
});
