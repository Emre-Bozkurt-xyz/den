/**
 * Tag normalization + booru query parsing (BACKBONE §5). Shared so the
 * client can preview the same normalization the server enforces (CLAUDE.md
 * hard invariant 5: "normalization is hinted in the UI, never silent") and
 * so the query parser used to render chips matches what the server resolves.
 */

export const TAG_NAME_MAX_LEN = 64;
const TAG_CHARSET = /^[a-z0-9_-]+$/;

/** trim → lowercase → spaces→hyphens → collapse repeated hyphens. Returns
 *  null if the result is empty, too long, or has chars outside [a-z0-9_-]
 *  after normalization — reject, don't silently mangle further. */
export function normalizeTagName(raw: string): string | null {
  const normalized = raw
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  if (!normalized || normalized.length > TAG_NAME_MAX_LEN) return null;
  if (!TAG_CHARSET.test(normalized)) return null;
  return normalized;
}

export interface ParsedTagQuery {
  /** Normalized tag names; media must have ALL of these. */
  positive: string[];
  /** Normalized tag names; media must have NONE of these. */
  negative: string[];
}

/** Booru-style query: `beach -screenshots` → AND on positives, NOT on
 *  negatives (BACKBONE §2/§5). Tokens that don't normalize to a valid tag
 *  name are dropped — they can never match a real tag anyway. */
export function parseTagQuery(raw: string): ParsedTagQuery {
  const positive: string[] = [];
  const negative: string[] = [];
  for (const token of raw.trim().split(/\s+/).filter(Boolean)) {
    const negated = token.startsWith('-') && token.length > 1;
    const bare = negated ? token.slice(1) : token;
    const normalized = normalizeTagName(bare);
    if (!normalized) continue;
    (negated ? negative : positive).push(normalized);
  }
  return { positive: [...new Set(positive)], negative: [...new Set(negative)] };
}
