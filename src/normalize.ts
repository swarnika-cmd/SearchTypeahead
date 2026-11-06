/** Longest query or prefix we accept, counted after normalisation. */
export const MAX_QUERY_LENGTH = 100;

/**
 * Converts raw user input into the form the trie stores:
 *   1. lowercase
 *   2. every character outside a-z and 0-9 becomes a space
 *   3. runs of spaces collapse into one, and the ends are trimmed
 *
 * Example: "  C++   Tutorial! " -> "c tutorial"
 *
 * The trie has exactly 37 child slots (a-z, 0-9, space). After this step every
 * character in the string has its own slot, so two different strings can never
 * end at the same trie node. Non-ASCII letters (e.g. "é") are dropped; a real
 * system would transliterate them first.
 */
export function normalizeQuery(raw: string): string {
  return raw.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

/**
 * Same as normalizeQuery, but for a prefix the user is still typing: a single
 * trailing space is kept, because "iphone " (word finished) should match
 * "iphone 15" but not "iphones".
 */
export function normalizePrefix(raw: string): string {
  return raw.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trimStart();
}
