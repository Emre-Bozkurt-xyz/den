/**
 * Embed URL detection (docs/EMBEDS.md §4). Shared by the client (composer
 * paste-detect chip, docs/EMBEDS.md §4.4) and the server (message.send body
 * sniffing, docs/EMBEDS.md §4.3) so both sides agree on exactly which URLs
 * become embed cards — CLAUDE.md "shared shapes live in /shared, never
 * redefine", same precedent as `tags.ts` normalization.
 */

export type EmbedProvider = 'instagram' | 'vault';
export type EmbedStatus = 'processing' | 'ready' | 'failed';
export type EmbedActionType = 'external' | 'read' | 'portal';

export interface DetectedEmbed {
  provider: EmbedProvider;
  /** The exact substring found in the input text (including any trailing
   *  punctuation a sentence glued onto it) — callers strip exactly this from
   *  the original body to get the caption, so it must round-trip losslessly
   *  through String.prototype.replace (docs/EMBEDS.md §4.3 "a caption gets
   *  its own bubble"). */
  matchedText: string;
  /** Canonical URL to store/fetch — normalized host + path, no query string. */
  url: string;
  /** Provider-specific id extracted from the URL (the IG shortcode). */
  providerRef: string;
}

// Instagram reels/posts only (docs/EMBEDS.md §4.3): strict host + path shape,
// anchored end-to-end so a lookalike host (instagram.com.evil.example, or a
// path with extra segments) can't slip through. Treat the URL as hostile
// input — this regex is the entire allowlist for what becomes a server-side
// fetch (server/src/embeds/instagram.ts).
const INSTAGRAM_URL_RE = /^https?:\/\/(?:www\.)?instagram\.com\/(reel|p)\/([A-Za-z0-9_-]+)\/?(?:\?\S*)?$/i;

// Coarse pre-filter: any http(s) URL token in free text. Provider-specific
// regexes above then validate each candidate — this only narrows down which
// substrings are worth checking.
const URL_TOKEN_RE = /https?:\/\/\S+/gi;

/** Scans `text` for the first URL matching a known embeddable pattern.
 *  Returns null when none is found — plain text, an unsupported host, a
 *  malformed IG URL, etc. */
export function detectEmbedUrl(text: string): DetectedEmbed | null {
  const tokens = text.match(URL_TOKEN_RE);
  if (!tokens) return null;

  for (const raw of tokens) {
    // Trailing punctuation a sentence tends to glue onto a pasted URL
    // ("check this out: https://instagram.com/reel/abc123." — the period).
    const trimmed = raw.replace(/[),.!?;:]+$/, '');
    const igMatch = INSTAGRAM_URL_RE.exec(trimmed);
    if (igMatch) {
      const kind = igMatch[1]!.toLowerCase();
      const shortcode = igMatch[2]!;
      return {
        provider: 'instagram',
        matchedText: raw,
        url: `https://www.instagram.com/${kind}/${shortcode}/`,
        providerRef: shortcode,
      };
    }
  }
  return null;
}

/** Removes the matched URL from free text, leaving any remaining words as a
 *  caption (docs/EMBEDS.md §4.4's chip: "sends as a card", not "replaces your
 *  words"). Null (not '') when nothing is left — a bare link has no caption,
 *  distinct from an explicit empty one. */
export function stripEmbedUrl(text: string, detected: DetectedEmbed): string | null {
  const rest = text.replace(detected.matchedText, '').trim();
  return rest || null;
}
