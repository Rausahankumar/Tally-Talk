/**
 * Deterministic name matching against a fixed list of candidate names.
 *
 * Exact match (case/whitespace-insensitive) is always tried first. Fuzzy
 * matching only runs when no exact match exists, and only ever considers
 * candidates already in the caller's list — nothing here calls out to an LLM,
 * and no result includes more than a handful of names, never the whole list.
 */
/** Below this similarity, a name is not considered a plausible match at all. */
const FUZZY_THRESHOLD = 0.75;
/**
 * How much better the best match must be than the runner-up before it is
 * accepted outright. Below this margin, two candidates are close enough that
 * guessing would be a real risk — the result is ambiguous instead.
 */
const AMBIGUITY_MARGIN = 0.1;
/** Cap on how many candidates an ambiguous result carries. */
const MAX_AMBIGUOUS_CANDIDATES = 5;
function normalize(value) {
  return value.trim().toLowerCase().replace(/\s+/g, ' ');
}
/** Classic edit distance: minimum single-character insertions/deletions/substitutions. */
function levenshteinDistance(a, b) {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  let previousRow = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i += 1) {
    const currentRow = [i];
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      currentRow.push(
        Math.min(
          currentRow[j - 1] + 1, // insertion
          previousRow[j] + 1, // deletion
          previousRow[j - 1] + cost,
        ),
      );
    }
    previousRow = currentRow;
  }
  return previousRow[b.length];
}
/** 1.0 for identical strings, 0.0 for completely dissimilar ones. */
function similarity(a, b) {
  const maxLength = Math.max(a.length, b.length);
  if (maxLength === 0) return 1;
  return 1 - levenshteinDistance(a, b) / maxLength;
}
/**
 * Best similarity of `shorter` against any equal-length window of `longer`.
 *
 * Whole-string similarity alone badly fails a very real case here: an
 * LLM-extracted item name like "cement" against a real Tally stock item named
 * "ACC Cement OPC 43 Grade" scores under 0.3 on length alone, despite being an
 * exact match for a real substring. Sliding a same-length window catches that
 * without resorting to fuzzy substring heuristics — this is still exact edit
 * distance, just against the best-aligned slice of the longer name.
 */
function partialSimilarity(shorter, longer) {
  if (shorter.length === 0) return longer.length === 0 ? 1 : 0;
  if (shorter.length >= longer.length) return similarity(shorter, longer);
  let best = 0;
  for (let start = 0; start <= longer.length - shorter.length; start += 1) {
    const window = longer.slice(start, start + shorter.length);
    best = Math.max(best, similarity(shorter, window));
    if (best === 1) break;
  }
  return best;
}
/** The stronger of whole-string and best-window similarity, in either direction. */
function combinedSimilarity(a, b) {
  const wholeString = similarity(a, b);
  const partial = a.length <= b.length ? partialSimilarity(a, b) : partialSimilarity(b, a);
  return Math.max(wholeString, partial);
}
/**
 * Match `query` against `candidateNames`. Requirement order is exact, then
 * deterministic fuzzy, then ambiguous, then not-found — never a guess between
 * close alternatives.
 */
export function matchName(query, candidateNames) {
  const normalizedQuery = normalize(query);
  // Exact match, case/whitespace-insensitive. More than one candidate
  // normalising to the same name is itself an ambiguity, not a pick.
  const exactMatches = candidateNames.filter((name) => normalize(name) === normalizedQuery);
  if (exactMatches.length === 1) {
    return { status: 'exact', matchedName: exactMatches[0], candidates: [] };
  }
  if (exactMatches.length > 1) {
    return {
      status: 'ambiguous',
      matchedName: null,
      candidates: exactMatches.slice(0, MAX_AMBIGUOUS_CANDIDATES),
    };
  }
  const scored = candidateNames
    .map((name) => ({ name, score: combinedSimilarity(normalizedQuery, normalize(name)) }))
    .filter((entry) => entry.score >= FUZZY_THRESHOLD)
    .sort((a, b) => b.score - a.score);
  if (scored.length === 0) {
    return { status: 'not_found', matchedName: null, candidates: [] };
  }
  const [best, second] = scored;
  if (second === undefined || best.score - second.score >= AMBIGUITY_MARGIN) {
    return { status: 'fuzzy', matchedName: best.name, candidates: [] };
  }
  return {
    status: 'ambiguous',
    matchedName: null,
    candidates: scored.slice(0, MAX_AMBIGUOUS_CANDIDATES).map((entry) => entry.name),
  };
}
