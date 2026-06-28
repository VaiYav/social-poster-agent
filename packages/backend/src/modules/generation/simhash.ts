/**
 * SimHash — locality-sensitive hash for near-duplicate detection.
 *
 * Used by the generation pipeline to avoid posting near-duplicate content
 * across runs. SimHash produces a 64-bit hash where similar texts produce
 * similar hashes (Hamming distance ≤ 3 = likely duplicate).
 *
 * Algorithm:
 * 1. Tokenize text into shingles (n-grams of words)
 * 2. Hash each shingle with a stable hash
 * 3. For each bit position, sum +1 if hash bit is 1, -1 if 0
 * 4. Final hash: bit is 1 if sum > 0, else 0
 */

const SHINGLE_SIZE = 3; // 3-word shingles
const HASH_BITS = 64;

/**
 * Stable string hash (FNV-1a 32-bit) — deterministic across runs.
 */
function fnv1aHash(str: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0; // unsigned 32-bit
}

/**
 * Tokenize text into lowercase word tokens.
 */
function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^\w\s]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length > 1);
}

/**
 * Generate shingles (n-grams of words) from text.
 */
function shingles(tokens: string[], size: number): string[] {
  if (tokens.length < size) return [tokens.join(' ')];
  const result: string[] = [];
  for (let i = 0; i <= tokens.length - size; i++) {
    result.push(tokens.slice(i, i + size).join(' '));
  }
  return result;
}

/**
 * Compute SimHash for a text string.
 * Returns a 64-bit hash as a hex string.
 */
export function simhash(text: string): string {
  const tokens = tokenize(text);
  const shingleList = shingles(tokens, SHINGLE_SIZE);

  // Accumulate bit votes
  const bitSums = new Array<number>(HASH_BITS).fill(0);

  for (const shingle of shingleList) {
    // Use two 32-bit hashes to get 64 bits
    const h1 = fnv1aHash(shingle);
    const h2 = fnv1aHash(shingle + '_salt');

    for (let i = 0; i < 32; i++) {
      bitSums[i] = (bitSums[i] ?? 0) + ((h1 >> i) & 1 ? 1 : -1);
      bitSums[i + 32] = (bitSums[i + 32] ?? 0) + ((h2 >> i) & 1 ? 1 : -1);
    }
  }

  // Convert bit sums to hash
  let high = 0;
  let low = 0;
  for (let i = 0; i < 32; i++) {
    if ((bitSums[i] ?? 0) > 0) high |= (1 << i);
    if ((bitSums[i + 32] ?? 0) > 0) low |= (1 << i);
  }

  // Convert to hex string (16 chars for 64 bits)
  const highHex = (high >>> 0).toString(16).padStart(8, '0');
  const lowHex = (low >>> 0).toString(16).padStart(8, '0');
  return highHex + lowHex;
}

/**
 * Compute Hamming distance between two SimHash hex strings.
 */
export function hammingDistance(hash1: string, hash2: string): number {
  if (hash1.length !== hash2.length) return HASH_BITS;

  const h1 = BigInt('0x' + hash1);
  const h2 = BigInt('0x' + hash2);
  const xor = h1 ^ h2;

  // Count set bits (population count)
  let count = 0;
  let n = xor;
  while (n > 0n) {
    count++;
    n &= n - 1n;
  }
  return count;
}

/**
 * Check if two texts are near-duplicates.
 * Threshold: Hamming distance ≤ 3 means likely duplicate.
 */
export function isNearDuplicate(text1: string, text2: string, threshold = 3): boolean {
  const h1 = simhash(text1);
  const h2 = simhash(text2);
  return hammingDistance(h1, h2) <= threshold;
}

/**
 * Check a PRECOMPUTED candidate SimHash against a set of existing hashes.
 * Returns true if within `threshold` Hamming distance of any of them.
 *
 * Prefer this over isDuplicateAgainstCorpus when the caller already holds the
 * candidate hash (e.g. it also stores it) — avoids recomputing simhash().
 */
export function isDuplicateHash(
  candidateHash: string,
  existingHashes: string[],
  threshold = 3,
): boolean {
  return existingHashes.some((existing) => hammingDistance(candidateHash, existing) <= threshold);
}

/**
 * Check a candidate text against a set of existing hashes.
 * Returns true if the candidate is a near-duplicate of any existing text.
 */
export function isDuplicateAgainstCorpus(
  candidateText: string,
  existingHashes: string[],
  threshold = 3,
): boolean {
  return isDuplicateHash(simhash(candidateText), existingHashes, threshold);
}
