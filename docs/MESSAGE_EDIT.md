# Message Edit (own messages, focus-menu entry)

**Status:** shipped 2026-07-22 — owner-requested pull-forward, not on the §13 roadmap (same posture as image paste, see §14 2026-07-22 entry).
**Executor note:** this doc is the brief. Read CLAUDE.md and PROJECT.md §5–§7, §11 before starting. Work top-to-bottom; each phase leaves the app working. `npm run typecheck && npm run lint && npm run test` must be green before any commit. Mirror the delete/restore implementation (`server/src/routes/chats.ts`, `server/src/chat/service.ts` `softDeleteMessages`/`restoreMessages`, `app/src/lib/realtime.tsx` `MessageDeleted`/`MessageRestored` cases) — it is the closest precedent for the whole loop.

## 1. What we're building

Users can edit the text of their own previous messages:

- **Entry point:** a new **Edit** row in the focus menu (`MessageFocusMenu`), shown only for own, non-pending messages that have a non-empty `body`.
- **Scope (owner decision, 2026-07-22):** any own message with a body — plain text messages **and** media captions. The edit only ever touches `body`, never media. No time limit (owner decision: unlimited, fits the closed-friend-circle trust model).
- **Composer edit mode:** choosing Edit fills the composer with the message body; attach + mic are hidden; the send button becomes an **Update** button (check icon). A slim bar above the composer (same slot/pattern as `ReplyPreviewBar`) shows "Editing message" + a one-line preview + an ✕ cancel.
- **Edited indicator:** a small muted "edited" label **below the bubble, outside it, on the side facing the screen center** (for `mine` right-aligned messages the label sits toward the bubble's left/inner edge; for others', toward the right/inner edge). Owner-specified placement.
- Everyone in the chat sees the updated body + indicator live via WS.

**Explicitly out of scope (don't build):** edit history / "show original", adding a caption to caption-less media (edit requires an existing non-empty body), editing voice/system messages, batch edit, editing others' messages under any condition, time-window enforcement.

## 2. Non-negotiables that apply here

- `assertMember` + **ownership** check on the edit route — same all-or-nothing 403 posture as `softDeleteMessages` (membership + ownership enforced in `chat/service.ts`, not the route).
- Soft-deleted messages are not editable (`deleted_at IS NULL` in the guard).
- New WS type goes into the `WsType` registry in `shared/src/ws.ts` — same envelope, no side-channel. `call.*` prefixes untouched.
- DTO changes live in `/shared` only.
- Never special-case DMs.
- No new dependencies.

## 3. Backend

### 3.1 Migration 007 — `edited_at`

Add `edited_at timestamptz` (nullable) to `messages` via `npm run db:generate` — never edit applied migrations. No index needed. The existing `idx_messages_body_trgm` trigram index covers search over edited bodies automatically.

Update PROJECT.md §5 as part of the same change.

### 3.2 Shared DTOs

- `Message` (`shared/src/api.ts`): add `editedAt: string | null` (ISO 8601). Update the server mapper (`server/src/mappers.ts`) accordingly — every path that builds a `MessageDto` must carry it (history page, search, restore, send echo).
- New request/response types:

```ts
/** POST /chats/:id/messages/:messageId/edit */
export interface EditMessageRequest { body: string }
export interface EditMessageResponse { message: Message }
```

- WS (`shared/src/ws.ts`): `WsType.MessageEdited = 'message.edited'`, payload:

```ts
export interface MessageEditedPayload { chatId: string; message: Message }
```

Carrying the full updated `Message` (like `message.restored` does) lets clients replace the cached row wholesale — no partial-patch reconstruction.

### 3.3 Service + route

`server/src/chat/service.ts` — `editMessage(viewerId, chatId, messageId, body)`:

- Assert membership; load the message; 403 unless `sender_id = viewerId`; 404/400 if not found, soft-deleted, or `kind NOT IN ('text','image','video')`.
- `body` is trimmed and must be non-empty (an empty text message is delete's job, not edit's) and within the same max length the send path enforces — reuse the same constant, don't restate the number.
- **No-op guard:** if the trimmed body equals the current body, return the message unchanged and signal the route to skip the broadcast (same "no phantom WS frame" rule as delete).
- Set `body` + `edited_at = now()`; return the full `MessageDto`.

`server/src/routes/chats.ts` — `POST /chats/:id/messages/:messageId/edit` (POST-verb convention, matching `/delete`, `/restore`, `/read`). On a real change, emit `makeEnvelope(WsType.MessageEdited, { chatId, message })` to `chatRoom(chatId)`. Return `{ message }`.

Update PROJECT.md §6 and §7 lists as part of the same change.

## 4. Client

### 4.1 Realtime (`app/src/lib/realtime.tsx`)

`case WsType.MessageEdited`: replace the message by id across all cached pages (`withAllPages`, map-replace on id match — messages can be edited on any page, not just the first). Then `invalidateQueries(['chats'])` — editing the newest message changes the chat-list preview, same rule as delete. No echo-dedup dance: the edit is applied REST-first (mutation response patches the cache) and the echo frame is an idempotent replace.

Known-accepted staleness: `ReplyPreview` snippets on messages *quoting* the edited message are denormalized at read time and won't update live — they correct themselves on the next refetch/reconnect (server is truth). Don't chase them.

### 4.2 ChatView edit mode

- New state: `editing: Message | null`, plus a ref stashing the pre-edit draft. `editing` and `replyingTo` are **mutually exclusive** — starting one clears the other.
- **Enter:** from the focus menu's Edit action (caller closes the menu, same contract as `onReply`). Stash current draft, set draft to `message.body`, focus the composer.
- **Submit:** trimmed, non-empty, and different from the original → `POST .../edit`, patch the cache from the response, exit edit mode, restore the stashed draft. Unchanged body → just cancel (no request).
- **Cancel** (✕ on the bar, or Escape on desktop): exit edit mode, restore the stashed draft.
- **Edge cases:** if a `message.deleted` frame removes the message being edited, cancel edit mode. `editing` is plain ChatView state — losing it on a breakpoint-crossing remount is accepted (same as `replyingTo`).
- The edit bar above the composer follows `ReplyPreviewBar`'s pattern (may be a sibling component, e.g. `EditingBar`, or a generalization — executor's call; don't over-abstract).

### 4.3 Composer edit mode

`Composer` gets an `editing: boolean` prop (or similar):

- Hide the attach button and the mic; the only trailing control is the submit button, restyled **Update** with a check icon, enabled on non-empty draft.
- Recording/gesture code paths are unreachable in edit mode (mic hidden) — don't add mode checks inside the gesture handlers, just don't render the mic.
- File paste (`handlePaste`) is a no-op in edit mode (surface the existing `onError` with a short message, or silently ignore files — pick one, keep text paste working).
- Enter-to-send on desktop submits the edit; the keyboard-focus-preservation behavior stays as-is.

### 4.4 Focus menu

New **Edit** row (Pencil icon, `lucide-react`) between Copy and Select, rendered when `mine && message.body && !deleted`. Same `onEdit(m)` caller-closes contract as every other row.

### 4.5 Edited indicator

Absolutely positioned **inside the bubble div** (which is `relative`), hanging past its outer edge on the side facing screen center (`right-full` for mine, `left-full` for others), vertically centered on the bubble:

- Render when `m.editedAt && !isStack`: a small muted label, e.g. `text-[10px] text-text-muted`, content "edited", with `title={formatSendTime(m.editedAt)}` for the timestamp on desktop hover. Edited messages always have a non-empty body, so the bubble (incl. a bare-media caption bubble) always exists to host it.
- **Placement (owner-specified, revised twice 2026-07-22):** originally a row below the bubble (added vertical height); then inline in the block's outer row (centered against bubble+reaction-pills together, not the bubble alone). Final form centers on the bubble itself and adds no layout size anywhere.
- Design tokens only; no new colors.

## 5. Verification

1. `npm run typecheck && npm run lint && npm run test` green. Add service-level tests for `editMessage` (ownership 403, deleted 400/404, no-op skip, happy path) mirroring the delete tests' shape if present.
2. Scripted two-account flow against the compose stack (definition of done, PROJECT.md §16): A sends → A edits → B's client shows new body + indicator live; B cannot edit A's message (403); editing a caption works; chat-list preview updates when the newest message is edited.
3. ⚠️ iOS flag for the standing real-device checklist: composer edit-mode focus/keyboard behavior on iOS Safari PWA (focus() outside a user gesture may not raise the keyboard — acceptable if so, but note it), and the edited-label tap target being decorative-only.

## 6. Docs to update in the same change

- PROJECT.md §5 (edited_at), §6 (route), §7 (WS type), §14 decision-log entry (owner-requested pull-forward; scope = text+captions, unlimited window, indicator outside-bottom-center).
- This doc's Status line → shipped.
