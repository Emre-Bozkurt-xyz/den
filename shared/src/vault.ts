/**
 * Vault Stage + portal DTOs (docs/EMBEDS.md §6.2/§6.4, Phase 4).
 *
 * The seam between Den's server and client for everything Vault-document
 * shaped. Vault's own API shapes are NOT re-exported here — the server
 * translates them (server/src/integrations/vaultClient.ts) so that Vault
 * contract drift never reaches the client, and so no Vault token or
 * service-principal detail can leak into a client payload.
 */

/** A Vault document pinned to a chat's Stage. */
export interface StageDoc {
  /** Den's own `chat_vault_docs.id` — the handle for remove/reorder. */
  id: string;
  /** Vault's document UUID — the handle for portal/read/metadata calls. */
  vaultDocumentId: string;
  title: string;
  /** Owner label for the card. For a group-owned doc Vault reports the GROUP
   *  name (docs/EMBEDS.md §7.1 item 3) — the service principal is never
   *  surfaced. Null when Vault couldn't be reached. */
  ownerName: string | null;
  /** First ~200 chars, frontmatter stripped. Null when unavailable. */
  snippet: string | null;
  /** ISO 8601, from Vault metadata. Null when Vault couldn't be reached; the
   *  grid falls back to `addedAt` ordering for those. */
  updatedAt: string | null;
  /** Whether THIS viewer may open the live portal. False for unlinked members
   *  (no Vault identity ⇒ no group membership ⇒ read-only relay). */
  canEdit: boolean;
  /** Den user id of whoever added it — attribution only, shared-wiki model. */
  addedBy: string | null;
  addedAt: string;
}

/** One row in the clone picker (docs/EMBEDS.md §7 Contract B2). Mirrors
 *  Vault's list shape minus fields Den's UI has no use for. */
export interface VaultPickerDoc {
  id: string;
  title: string;
  /** e.g. "Work/Specs" — rendered beneath the title in smaller, desaturated
   *  text. Null for a doc sitting at the root. */
  folderPath: string | null;
  updatedAt: string;
  snippet: string | null;
}

/** `GET /chats/:id/stage` */
export interface StageResponse {
  docs: StageDoc[];
  /** False when the viewer hasn't linked Vault — the client shows a Connect
   *  prompt instead of the picker, since listing and cloning both need the
   *  viewer's own OAuth token. */
  viewerLinked: boolean;
  /** False when the server has no `VAULT_SERVICE_TOKEN`; the Stage degrades to
   *  read-only (no add/remove) rather than failing (docs/EMBEDS.md §7.1 #2). */
  writable: boolean;
}

/** `POST /chats/:id/stage/docs` — create-blank or clone, one route.
 *  Exactly one of `title` (create) or `sourceDocumentId` (clone) is used;
 *  `sourceDocumentId` wins if both are somehow present. */
export interface AddStageDocRequest {
  /** Create a new blank group-owned doc with this title. */
  title?: string;
  /** Clone this Vault doc (by id, from the picker) into the chat's group. */
  sourceDocumentId?: string;
}

export interface AddStageDocResponse {
  doc: StageDoc;
  /** Present only for a freshly created blank doc: the client opens the portal
   *  straight away (owner decision — you made it to write in it). A clone
   *  returns null and the client stays on the grid. */
  portalUrl: string | null;
}

/** `POST /chats/:id/stage/docs/:docId/portal` → a single-use editor URL.
 *  NEVER cache or reuse this: Vault's boot token is single-use, so even an
 *  iframe refresh fails closed and requires a freshly minted session. */
export interface PortalSessionResponse {
  portalUrl: string;
}

/** `GET /chats/:id/stage/rendered/:vaultDocumentId` — the read view + the
 *  source of the card's "paper thumbnail" (docs/EMBEDS.md §6.2.1).
 *
 *  ⚠️ `html` is Vault-sanitized but Den still renders it into its own chrome;
 *  private-asset images inside will NOT load for Den's cross-origin viewers
 *  (docs/EMBEDS.md §7.1 item 5) — expected, not a bug to chase from Den. */
export interface RenderedDocResponse {
  html: string;
  title: string;
  updatedAt: string | null;
}

export const StageLimits = {
  /** Matches Vault's own cap for `GET /api/embed/documents?limit=`. */
  pickerLimit: 50,
  /** Vault rejects a `query` longer than this with a 400. */
  maxPickerQueryLength: 200,
  maxTitleLength: 200,
} as const;
