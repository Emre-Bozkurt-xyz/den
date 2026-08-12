/**
 * Tag normalization + booru query parsing (BACKBONE §5). Shared so the
 * client can preview the same normalization the server enforces (CLAUDE.md
 * hard invariant 5: "normalization is hinted in the UI, never silent") and
 * so the query parser used to render chips matches what the server resolves.
 */

export const TAG_NAME_MAX_LEN = 64;
const TAG_CHARSET = /^[a-z0-9_-]+$/;

/**
 * Reserved tag names that make a media item render blurred behind a
 * tap-to-reveal pill (docs/MEDIA_ATTACHMENTS.md D5/D6).
 *
 * These are ORDINARY tags — same table, same per-chat registry, same
 * shared-wiki permissions (any member may attach or detach them on anyone's
 * media), same normalization, and they search like any other tag (`nsfw`,
 * `-nsfw`). Nothing about them is special-cased in the tag layer; the only
 * thing that reads them specially is `sensitivityOf`, whose result rides on
 * `MediaInfo.sensitivity`.
 *
 * Deliberately NOT a column: the owner's standing rule is to categorize with
 * tags rather than grow the schema, and this way the gallery's existing
 * search, batch-tag panel and viewer tag editor all work on day one.
 *
 * ⚠️ Blur is cosmetic, not a security control (D10) — the real thumbnail
 * bytes are still delivered to every member of the chat.
 */
export const SENSITIVE_TAGS = ['nsfw', 'spoiler'] as const;

export type Sensitivity = (typeof SENSITIVE_TAGS)[number];

/** Which blur label (if any) a set of attached tag names earns.
 *  Both attached → 'nsfw' wins: it's the stronger claim, and showing one
 *  label keeps the overlay from turning into a list. Order-independent. */
export function sensitivityOf(tagNames: readonly string[]): Sensitivity | null {
  if (tagNames.includes('nsfw')) return 'nsfw';
  if (tagNames.includes('spoiler')) return 'spoiler';
  return null;
}

/** True for tag names that drive blur — used by the UI to render the two
 *  quick toggles separately from free-form descriptive tags. */
export function isSensitiveTag(name: string): name is Sensitivity {
  return (SENSITIVE_TAGS as readonly string[]).includes(name);
}

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
