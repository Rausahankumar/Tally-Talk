import { describe, expect, it, vi } from 'vitest';
import { TallyConnectionError, createTallyClient } from '../src/tally/client.js';
function fakeFetch(response) {
  return vi.fn(async () => new Response(response.body, { status: response.status ?? 200 }));
}
const SUCCESS_BODY = `<ENVELOPE><HEADER><STATUS>1</STATUS></HEADER><BODY><DATA><COLLECTION>
  <LEDGER NAME="Ramesh"><PARENT TYPE="String">Sundry Debtors</PARENT></LEDGER>
</COLLECTION></DATA></BODY></ENVELOPE>`;
describe('createTallyClient', () => {
  it('posts a COLLECTION export request to the configured host and port', async () => {
    const fetchImpl = fakeFetch({ body: SUCCESS_BODY });
    const client = createTallyClient({
      host: '127.0.0.1',
      port: 9000,
      companyName: 'Nirmal FMCG Traders Ltd',
      fetchImpl,
    });
    await client.exportCollection('Ledger', ['NAME', 'PARENT']);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe('http://127.0.0.1:9000');
    expect(init.method).toBe('POST');
    expect(String(init.body)).toContain(
      '<SVCURRENTCOMPANY>Nirmal FMCG Traders Ltd</SVCURRENTCOMPANY>',
    );
  });
  it('parses the response into raw records', async () => {
    const client = createTallyClient({
      host: '127.0.0.1',
      port: 9000,
      companyName: 'Acme',
      fetchImpl: fakeFetch({ body: SUCCESS_BODY }),
    });
    const rows = await client.exportCollection('Ledger', ['NAME', 'PARENT']);
    expect(rows).toEqual([{ NAME: 'Ramesh', PARENT: 'Sundry Debtors' }]);
  });
  it('wraps a network failure in TallyConnectionError with a diagnostic hint', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('ECONNREFUSED');
    });
    const client = createTallyClient({
      host: '127.0.0.1',
      port: 9000,
      companyName: 'Acme',
      fetchImpl,
    });
    await expect(client.exportCollection('Ledger', ['NAME'])).rejects.toThrow(TallyConnectionError);
    await expect(client.exportCollection('Ledger', ['NAME'])).rejects.toThrow(
      /Is TallyPrime running/,
    );
  });
  it('treats a non-2xx HTTP response as a connection failure', async () => {
    const client = createTallyClient({
      host: '127.0.0.1',
      port: 9000,
      companyName: 'Acme',
      fetchImpl: fakeFetch({ status: 500, body: 'server error' }),
    });
    await expect(client.exportCollection('Ledger', ['NAME'])).rejects.toThrow(TallyConnectionError);
  });
  it('surfaces a rejected-request response as a distinct error rather than an empty result', async () => {
    const client = createTallyClient({
      host: '127.0.0.1',
      port: 9000,
      companyName: 'Acme',
      fetchImpl: fakeFetch({ body: '<RESPONSE>Unknown Request, cannot be processed</RESPONSE>' }),
    });
    await expect(client.exportCollection('Ledger', ['NAME'])).rejects.toThrow(
      /rejected the request/,
    );
  });
  it('includes CHILDOF in the request when the childOf option is given', async () => {
    const fetchImpl = fakeFetch({ body: SUCCESS_BODY });
    const client = createTallyClient({
      host: '127.0.0.1',
      port: 9000,
      companyName: 'Acme',
      fetchImpl,
    });
    await client.exportCollection('Batch', ['NAME', 'PARENT', 'GODOWNNAME', 'CLOSINGBALANCE'], {
      childOf: 'Apple',
    });
    const [, init] = fetchImpl.mock.calls[0];
    expect(String(init.body)).toContain('<CHILDOF>Apple</CHILDOF>');
  });
  it('omits CHILDOF when no childOf option is given', async () => {
    const fetchImpl = fakeFetch({ body: SUCCESS_BODY });
    const client = createTallyClient({
      host: '127.0.0.1',
      port: 9000,
      companyName: 'Acme',
      fetchImpl,
    });
    await client.exportCollection('Ledger', ['NAME']);
    const [, init] = fetchImpl.mock.calls[0];
    expect(String(init.body)).not.toContain('CHILDOF');
  });
  it('aborts the request after the configured timeout', async () => {
    const fetchImpl = vi.fn(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
        }),
    );
    const client = createTallyClient({
      host: '127.0.0.1',
      port: 9000,
      companyName: 'Acme',
      fetchImpl,
      timeoutMs: 20,
    });
    await expect(client.exportCollection('Ledger', ['NAME'])).rejects.toThrow(TallyConnectionError);
  });
});
