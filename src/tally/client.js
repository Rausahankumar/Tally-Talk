/**
 * Tally HTTP client.
 *
 * Export only. There is no method here that could write to Tally — the
 * project's core rule is that nothing but a user-confirmed, backend-validated
 * voucher post ever reaches Tally, and that arrives in a later phase with its
 * own explicit posting path. `fetch` is injectable so tests never need a
 * running TallyPrime instance.
 */
import { buildCollectionRequest, parseCollectionResponse } from './xml.js';
/** Tally's HTTP interface is local; a slow or hung instance should fail fast. */
const DEFAULT_TIMEOUT_MS = 10_000;
export class TallyConnectionError extends Error {
  constructor(host, port, cause) {
    super(
      `Could not reach TallyPrime at ${host}:${port}. Is TallyPrime running with the company open? (${cause instanceof Error ? cause.message : String(cause)})`,
    );
    this.name = 'TallyConnectionError';
  }
}
export function createTallyClient(options) {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const url = `http://${options.host}:${options.port}`;
  return {
    async exportCollection(masterType, fields, exportOptions) {
      // Distinct per call only to make server-side logs traceable; no
      // significance to Tally itself.
      const collectionName = `TallyTalk_${masterType}_${Date.now()}`;
      const body = buildCollectionRequest({
        collectionName,
        masterType,
        companyName: options.companyName,
        fields,
        childOf: exportOptions?.childOf,
      });
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), timeoutMs);
      let response;
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
      // Callers needing a specialised shape (e.g. StockItem's GST/pricing
      // `.LIST` parsing — see xml.js) pass their own parser; every other
      // caller keeps today's plain-field flattening, unchanged.
      const parse = exportOptions?.parse ?? ((text) => parseCollectionResponse(text, masterType.toUpperCase()));
      return parse(xml);
    },
  };
}
