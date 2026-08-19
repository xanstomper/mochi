// Small dependency-free utilities ported from OpenFable (xanstomper/OpenFable)
// packages/shared/src/util/{slug,binary}.ts, rebranded into Mochi. Intentionally
// tiny: Mochi stays zero-dep, so these are hand-rolled rather than pulling in a
// package.

const ADJECTIVES = [
  'brave', 'calm', 'clever', 'cosmic', 'crisp', 'curious', 'eager', 'gentle',
  'glowing', 'happy', 'hidden', 'jolly', 'kind', 'lucky', 'mighty', 'misty',
  'neon', 'nimble', 'playful', 'proud', 'quick', 'quiet', 'shiny', 'silent',
  'stellar', 'sunny', 'swift', 'tidy', 'witty',
] as const;

const NOUNS = [
  'cabin', 'cactus', 'canyon', 'circuit', 'comet', 'eagle', 'engine', 'falcon',
  'forest', 'garden', 'harbor', 'island', 'knight', 'lagoon', 'meadow', 'moon',
  'mountain', 'nebula', 'orchid', 'otter', 'panda', 'pixel', 'planet', 'river',
  'rocket', 'sailor', 'squid', 'star', 'tiger', 'wizard', 'wolf',
] as const;

/** Readable random name like "clever-comet" (OpenFable Slug). */
export function randomSlug(): string {
  return `${ADJECTIVES[Math.floor(Math.random() * ADJECTIVES.length)]}-${NOUNS[Math.floor(Math.random() * NOUNS.length)]}`;
}

export interface BinaryResult {
  found: boolean;
  /** Insertion index when not found; the item's index when found. */
  index: number;
}

/** Binary search over a sorted-by-`compare` array (OpenFable Binary.search). */
export function binarySearch<T>(array: T[], id: string, compare: (item: T) => string): BinaryResult {
  let left = 0;
  let right = array.length - 1;
  while (left <= right) {
    const mid = Math.floor((left + right) / 2);
    const midId = compare(array[mid]);
    if (midId === id) return { found: true, index: mid };
    if (midId < id) left = mid + 1;
    else right = mid - 1;
  }
  return { found: false, index: left };
}

/** Insert into a sorted array keeping it sorted; returns a new array (copy). */
export function binaryInsert<T>(array: T[], item: T, compare: (item: T) => string): T[] {
  const { index } = binarySearch(array, compare(item), compare);
  const out = array.slice();
  out.splice(index, 0, item);
  return out;
}

/** Insert into a sorted array in place; returns the same array. */
export function binaryInsertInPlace<T>(array: T[], item: T, compare: (item: T) => string): T[] {
  const { index } = binarySearch(array, compare(item), compare);
  array.splice(index, 0, item);
  return array;
}

// ---------------------------------------------------------------------------
// Sortable ID + lazy singleton, ported from OpenFable
// packages/shared/src/util/identifier.ts and lazy.ts.
// ---------------------------------------------------------------------------
let lastTs = 0;
let idCounter = 0;

/**
 * A lexicographically ascending ID of fixed length: a 12-hex-chars timestamp
 * component (sortable with string `<`/`>`) plus random base62 chars. Two IDs
 * made in the same millisecond keep their call order via the counter. Returns
 * strings that sort oldest -> newest, which beats UUIDs when listing recent
 * autopsies / lessons / checks without a separate timestamp column.
 */
export function sortableId(timestamp = Date.now()): string {
  if (timestamp !== lastTs) {
    lastTs = timestamp;
    idCounter = 0;
  }
  idCounter++;
  const t = BigInt(timestamp) * BigInt(0x1000) + BigInt(idCounter);
  const timeBytes = Buffer.alloc(6);
  for (let i = 0; i < 6; i++) {
    timeBytes[i] = Number((t >> BigInt(40 - 8 * i)) & BigInt(0xff));
  }
  const chars = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
  let rand = '';
  for (let i = 0; i < 14; i++) rand += chars[Math.floor(Math.random() * chars.length)];
  return timeBytes.toString('hex') + rand;
}

/** Memoizing singleton initializer (OpenFable lazy): call once, reuse forever. */
export function lazy<T>(init: () => T): () => T {
  let value: T | undefined;
  let loaded = false;
  return () => {
    if (!loaded) {
      loaded = true;
      value = init();
    }
    return value as T;
  };
}

/**
 * Basename of a path handling both / and \ (OpenFable path.getFilename).
 * Returns '' for empty/undefined.
 */
export function getFilename(path: string | undefined): string {
  if (!path) return '';
  const trimmed = path.replace(/[/\\]+$/, '');
  const parts = trimmed.split(/[/\\]/);
  return parts[parts.length - 1] ?? '';
}

/** Directory part of a path (OpenFable path.getDirectory). */
export function getDirectory(path: string | undefined): string {
  if (!path) return '';
  const trimmed = path.replace(/[/\\]+$/, '');
  const parts = trimmed.split(/[/\\]/);
  return parts.slice(0, parts.length - 1).join('/') + '/';
}

/** Filename truncated in the middle, keeping the extension (OpenFable
 *  getFilenameTruncated). E.g. "veryLongNa…file.ts". */
export function getFilenameTruncated(path: string | undefined, maxLength = 20): string {
  const filename = getFilename(path);
  if (filename.length <= maxLength) return filename;
  const lastDot = filename.lastIndexOf('.');
  const ext = lastDot <= 0 ? '' : filename.slice(lastDot);
  const available = maxLength - ext.length - 1; // -1 for ellipsis
  if (available <= 0) return filename.slice(0, maxLength - 1) + '…';
  return filename.slice(0, available) + '…' + ext;
}

/** Truncate long text in the middle so both ends survive (OpenFable
 *  truncateMiddle). Best for CLI/dashboard lines where the head (what
 *  happened) and tail (where) matter more than the middle. */
export function truncateMiddle(text: string, maxLength = 20): string {
  if (text.length <= maxLength) return text;
  const available = maxLength - 1; // ellipsis
  const start = Math.ceil(available / 2);
  const end = Math.floor(available / 2);
  return text.slice(0, start) + '…' + text.slice(-end);
}