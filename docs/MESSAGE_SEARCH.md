# Message Search (Discord-style, per-chat)

**Status:** planned, owner-approved roadmap item — listed as "in flight" in `docs/PROJECT.md` §13.
**Executor note:** this doc is the brief. Read CLAUDE.md and the referenced PROJECT.md sections before starting. Work top-to-bottom; each phase leaves the app working. `npm run typecheck && npm run lint && npm run test` must be green before any commit.

## 1. What we're building

Per-chat message search, scoped like Discord's:

- **Text pattern** over `messages.body` (text messages *and* media captions — both live in `body`).
- **Filters:** sender (`from`), date range (`since` / `until`). Combinable with text or usable alone (e.g. "everything Alice sent in March").
- **Results panel:** newest-first list of matching messages (sender, timestamp, snippet with the match highlighted). Infinite-scroll for more results.
- **Tap a result → jump to that message in the chat**, reusing the existing gallery jump-to-message mechanism (auto-page older history until loaded, scroll into view, brief highlight).
- **Mobile:** search is a full-screen overlay over the chat. Jumping to a message closes the overlay, but search state (query, filters, fetched results) is preserved — reopening search shows it exactly as left.
- **Desktop:** search renders as a proper right-side panel (~360px) inside the chat pane; the message list shrinks beside it. No overlay.

**Explicitly out of scope (icebox, don't build):** cross-chat/global search, `has:image`-style filters, `from:@name` token parsing inside the text input, search inside the gallery, fuzzy/stemmed ranking. Plain filter controls only.

## 2. Non-negotiables that apply here

- `assertMember(userId, chatId)` on the search route — search must never widen visibility across chats (hard invariant 1).
- Exclude soft-deleted messages: `deleted_at IS NULL` (hard invariant 8).
- Keyset pagination on `id` (`before` cursor), **no OFFSET** — Discord-style "jump to page 47" is not wanted anyway.
- No new WS types needed; results are a point-in-time snapshot, refreshed only by re-running the query. Do not invent a side-channel.
- DTOs live in `/shared` and are imported by both sides.
- Never special-case DMs.

## 3. Backend

### 3.1 Migration 006 — trigram index

Search must stay fast "no matter how big" the chat gets, and it's substring matching (Discord-like), so use `pg_trgm`, not tsvector FTS (FTS is word/stemmer-based, does poorly on substrings and mixed-language chats).

```sql
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE INDEX idx_messages_body_trgm ON messages USING gin (body gin_trgm_ops);
```

New migration via `npm run db:generate` / drizzle custom migration — never edit applied migrations. Note the extension needs to work both in the docker-compose Postgres and prod VPS Postgres (standard contrib module, should be present; verify in the compose stack).

Update PROJECT.md §5 (data model) with the new index/extension as part of the same change (CLAUDE.md convention).

### 3.2 Shared DTOs (`shared/src/api.ts`)

```ts
/** GET /chats/:id/messages/search — keyset-paginated, id DESC. */
export interface SearchMessagesQuery {
  q?: string;        // text pattern; plain substring, case-insensitive
  from?: string;     // sender userId
  since?: string;    // ISO date (inclusive, start of day, UTC)
  until?: string;    // ISO date (inclusive, end of day, UTC)
  before?: string;   // keyset cursor (message id)
  limit?: string;
}

export interface SearchMessagesResponse {
  messages: Message[];        // reuse the existing Message DTO (replies/reactions come along free)
  nextCursor: string | null;
  totalCount: number | null;  // populated on the first page only (no `before`); null on later pages
}
```

Add a `searchPageDefault` (25) / `searchPageMax` (50) to `ChatLimits`.

### 3.3 Route — `GET /chats/:id/messages/search` (`server/src/routes/chats.ts`)

- `preHandler: requireAuth`, then `assertMember` — same shape as the existing `/chats/:id/messages` handler.
- Validate: at least one of `q` / `from` / `since` / `until` must be present, else `validation('empty search')`. `q` trimmed; reject `q` longer than 256 chars. `from` must parse as an id. Dates must parse; `since > until` → validation error.
- Implementation in `server/src/chat/service.ts` as `searchMessages(chatId, filters, before, limit, userId)`:
  - Drizzle query (no raw SQL needed — `ilike` is supported): `chat_id = ? AND deleted_at IS NULL AND body IS NOT NULL`, plus:
    - `q` → `body ILIKE '%' || ? || '%'` with the user input **escaped for ILIKE** (`\`, `%`, `_` → backslash-escaped). This is a correctness *and* abuse concern — an unescaped `%` turns a pattern into a full scan of everything.
    - `from` → `sender_id = ?`
    - `since`/`until` → `created_at >= ? AND created_at < ? + 1 day` (treat dates as UTC day bounds; keep it simple and document it).
  - `before` cursor → `id < ?`. Order `id DESC`, `limit + 1` to detect `nextCursor` — mirror `getMessagesPage` exactly.
  - Map through the same message mapper `getMessagesPage` uses so replies/reactions/media attachments are populated identically.
  - `totalCount`: run a `COUNT(*)` with the same WHERE only when `before` is absent.
- **System messages:** exclude `kind = 'system'` from results (they're app-generated, searching them is noise).

## 4. Frontend

### 4.1 State model — survive overlay close (the hard requirement)

Two layers, both already-established patterns in this codebase:

1. **Results cache:** TanStack `useInfiniteQuery` keyed `['messageSearch', chatId, q, from, since, until]`. Closing the overlay does not clear the cache, so reopening with the same params re-renders every already-fetched page instantly. Give it a generous `staleTime` (e.g. 5 min) so reopening doesn't silently refetch and shift results under the user.
2. **Form state (query text, filters, panel-open flag):** lives in `ChatView` as a single `searchState` object, seeded from an App-level `useRef` cache keyed by `chat.id` — **exactly the `draftCacheRef` pattern in `App.tsx` (see its comment)**, and for the same reason: `ChatView` remounts when crossing the mobile/desktop breakpoint, and per-chat state must survive that. Add `initialSearchState` / `onSearchStateChange` props next to `initialDraft` / `onDraftChange`.

With both layers, the flow "search → tap result → overlay closes → reopen search" restores text, filters, and results without any refetch. (Result-list scroll position is allowed to reset; don't build scroll restoration.)

New hook: `app/src/hooks/useMessageSearch.ts` mirroring `useMessages.ts` (infinite query, `nextCursor` → `before`). Only enable the query when the search form has been submitted with at least one non-empty criterion — don't search-as-you-type on every keystroke; fire on Enter/submit (Discord behavior), which also keeps the query-key space small.

### 4.2 Jump-to-message wiring

The mechanism exists (`jumpToMessageId` prop on `ChatView` + the auto-page effect around `ChatView.tsx:307`). Two changes:

- `ChatView` needs an internal way to set the jump target for the **already-open** chat (search lives inside `ChatView`; no `App.openChat` round-trip). Add local `jumpTarget` state that feeds the same effect that `jumpToMessageId` feeds today.
- The effect guards with `jumpedRef` (one jump per mount). Reset the guard whenever the jump target *changes*, so a second search-jump in the same session works. Verify the existing gallery jump path still behaves (it passes the prop at mount).

On mobile, a result tap does: set jump target → close overlay (in that order, single interaction). On desktop, the panel stays open — tap just scrolls/highlights the message in the list beside it (Discord behavior).

### 4.3 Layout

**Entry point:** a search (magnifier) icon in the `ChatView` header, next to the existing gallery button.

**Mobile (`useIsMobile`):** full-screen overlay (fixed inset-0, `z` above the chat but below `MediaViewer`'s layer). Structure top-to-bottom:
- Header: back arrow (closes overlay, state preserved), text input (autofocus, `enterkeyhint="search"`), submit on Enter.
- Filter row: sender select (chat members, from `chat.members`), since/until date inputs (`<input type="date">`). Active filters render as dismissible chips.
- Results list: scrollable, infinite (fetch next page on near-bottom, same sentinel pattern as `ChatGallery`).
- Register the overlay on the back stack (`useBackHandler`, LIFO — same as `MediaViewer` / focus menu) so device back closes search, not the chat.

**Desktop:** inside `ChatView`'s root, a flex row: message column (`flex-1 min-w-0`) + search panel (`w-[360px] shrink-0 border-l`) when open. Same header/filters/results stack, plus an X to close. The composer stays full-width under the message column only — the panel is full-height beside the whole chat column (Discord does exactly this).

### 4.4 Result rows

- Sender display name + timestamp (reuse `datetime.ts` helpers) + body snippet.
- **Highlighting:** client-side, case-insensitive split of the body on the raw query string, matched span wrapped in a `<mark>`-styled span. React text nodes only — no `dangerouslySetInnerHTML`, ever.
- Long bodies: clamp to ~3 lines (`line-clamp-3`); if the match sits beyond the clamp, window the snippet around the first match (leading `…`).
- Media messages matched via caption: show a small kind glyph (image/video/voice icon) before the snippet. No thumbnails in v1.
- Filter-only searches (no `q`): no highlight, show the plain body; media messages with empty body show a kind label ("Photo", "Voice message").

### 4.5 iOS flags (for the stage-gate checklist — dev device is Android)

- Overlay height: `100dvh` + `env(safe-area-inset-*)` top/bottom padding, like existing overlays.
- Keyboard-open behavior of the autofocused input inside a fixed overlay (iOS Safari viewport jump) — known risk, flag for the iPhone pass.
- `<input type="date">` renders as the native iOS wheel — fine, but verify the cleared/empty state is reachable.
- `touch-action: manipulation` on result rows and filter chips.

## 5. Docs & bookkeeping (same change, not a follow-up)

- PROJECT.md §14 decision log: entry for message search shipping, dated, with the pg_trgm/ILIKE decision and the mobile-overlay/desktop-panel split.
- PROJECT.md §5: note the trgm extension + index in the data model section.
- PROJECT.md §6: add the route to the API surface.
- PROJECT.md §13: move this item from "in flight" to shipped; the out-of-scope list from §1 above (global search, `has:` filters, token parsing, fuzzy ranking) is already in the Icebox there.

## 6. Verification (definition of done)

Scripted two-account flow against the compose stack (pattern: the Stage 2–5 verification scripts):

1. Seed a chat with ~60 messages from two senders across ≥3 distinct days, including media-with-caption and a few soft-deleted messages.
2. `q` substring match hits text and captions; is case-insensitive; `%`/`_` in the query are treated literally (seed a message containing a literal `%` to prove it).
3. `from` filter, date range filter, and combinations each return exactly the expected ids.
4. Deleted and `system` messages never appear.
5. Pagination: `limit` + `before` walk the full result set with no dupes/gaps; `totalCount` correct on page 1, `null` after.
6. Non-member gets 403; the chat never leaks into their results.
7. Empty-criteria request → 400 validation error.
8. UI smoke (manual or Playwright): search → tap result → chat scrolls + highlights → reopen search → query, filters, and results intact; second jump from the same panel works; desktop panel pushes the chat and both stay usable.
9. `npm run typecheck && npm run lint && npm run test` green.

Commit granularity: `feat(search): migration + search endpoint`, `feat(search): search panel UI + jump wiring`, `docs: backbone entries for message search` (or fold docs into the relevant commits).
