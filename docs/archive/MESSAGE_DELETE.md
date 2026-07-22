# Message deletion + multi-select — implementation plan

> Scope authority: BACKBONE §2 item **11** (added 2026-07-21 by explicit owner override — see §15 decision log). Hard wipe / retention timer / trash page are **§13 Icebox, out of scope here**.

## 0. The one-paragraph version

A sender can soft-delete their own messages. Deletion fans out over WS immediately so it vanishes from every member's open chat; the deleter gets a ~10s **undo toast**. Undo restores it for everyone. Multi-select (long-press → selection mode; shift-click ranges on desktop) allows bulk delete + copy. `messages.deleted_at` already exists and is already filtered in every read path — **this ships with no migration**.

## 1. Invariants this must not break

1. **Authorization = chat membership.** Every new route calls `assertMember(userId, chatId)`. Non-negotiable (CLAUDE.md #1).
2. **Own messages only.** Additionally require `message.senderId === userId` for *every* id in the batch. No admin/moderator path — §1 of BACKBONE lists moderation as a non-goal.
3. **Soft deletes only** (CLAUDE.md #8). Set `deleted_at`; never `DELETE FROM`. **No R2 object deletion, no `media`/`media_tags` row deletion, no `usage_count` decrement.** Those belong to the iceboxed wipe.
4. **All realtime traffic uses `WsEnvelope`** (CLAUDE.md #4) — add `type` values, never a side-channel.
5. **Shared types live in `/shared`** and are imported by both sides.
6. Reserved `call.signal.*` / `call.state.*` prefixes stay untouched (§11).

## 2. Shared (`/shared`)

### `shared/src/ws.ts`
Add to `WsType`:
```ts
// message lifecycle (Stage 6 / §2 item 11)
MessageDeleted: 'message.deleted',
MessageRestored: 'message.restored',
```
Payloads — **batched by design**, so a 30-message bulk delete is one frame, not 30:
```ts
/** Server → client (room broadcast): these messages are gone for everyone.
 *  Ids only — the client already has the bodies and is removing them. */
export interface MessageDeletedPayload {
  chatId: string;
  messageIds: string[];
}

/** Server → client (room broadcast): an undo put these back. Carries FULL
 *  message objects, not ids — non-deleter clients dropped their copies on
 *  `message.deleted` and cannot reconstruct them without a refetch. */
export interface MessageRestoredPayload {
  chatId: string;
  messages: import('./api.js').Message[];
}
```

### `shared/src/api.ts`
```ts
/** POST /chats/:id/messages/delete and .../restore. All ids must belong to
 *  this chat and be sent by the caller — mixed batches are rejected whole. */
export interface MessageIdsRequest {
  messageIds: string[];
}
```
Add to `ChatLimits`: `deleteBatchMax: 100`.

## 3. Server

### `server/src/chat/service.ts`
Two functions, both all-or-nothing (validate the entire batch, then write):

```
softDeleteMessages(viewerId, chatId, messageIds) -> string[]  // ids actually transitioned
restoreMessages(viewerId, chatId, messageIds)   -> Message[]  // full DTOs for the WS payload
```

Rules for both:
- `assertMember(viewerId, chatId)` first.
- Reject empty batch and `> ChatLimits.deleteBatchMax` with `400`.
- Load the rows by id; if **any** id is missing, belongs to a different `chat_id`, or has `sender_id !== viewerId` → **`403`, write nothing**. Partial success is a worse UX than a clean refusal and leaks which ids exist.
- **Idempotent:** deleting an already-deleted message is a success no-op; same for restoring a live one. Return only the ids that actually changed, so the WS broadcast doesn't announce phantom changes.
- `restoreMessages` has **no server-side time limit**. The ~10s is purely the toast's lifetime on the client. This costs nothing now and is deliberately the seed the future trash page grows from.

### `server/src/routes/chats.ts`
```
POST /chats/:id/messages/delete   body: MessageIdsRequest
POST /chats/:id/messages/restore  body: MessageIdsRequest
```
`POST`-with-body rather than `DELETE`-with-body, matching the existing `POST /chats/:id/read` convention in this file.

After each, broadcast to the chat room (**not** `user:` rooms) exactly like `MessageNew` does — sender included, so the deleter's own other devices update too:
```ts
app.io?.to(chatRoom(id)).emit('ws', makeEnvelope(WsType.MessageDeleted, { chatId, messageIds }));
```
Skip the broadcast entirely when the changed-id list is empty.

**No push notification** on delete or restore.

### Already correct — verify, don't re-implement
`deleted_at` is already filtered in `chat/service.ts` (history `:32`, unread count `:42`, page query `:153`) and `media/gallery.ts` (`:51`, `:120`, `:125`). So a deleted message already drops out of history, unread counts, the chat-list preview (`lastMessageOf`), and every gallery/tag query for free. **Confirm this by reading; add nothing.**

## 4. Client

### `app/src/lib/chats.ts`
`deleteMessages(chatId, messageIds)` / `restoreMessages(chatId, messageIds)` wrapping `api()`.

### `app/src/lib/realtime.tsx`
Two new cases alongside `MessageNew`/`MediaReady` (`:67`–`:99`):
- `MessageDeleted` → drop those ids from the `['messages', chatId]` cache **across all pages** (not just the first — a bulk delete can span pages), then `qc.invalidateQueries(['chats'])` so the sidebar preview and unread badge recompute. Deleting the newest message changes `lastMessage`, so this invalidation is required, not optional.
- `MessageRestored` → reinsert and re-sort by numeric id descending within the first page. Then invalidate `['chats']`.

### `app/src/components/ChatView.tsx`
**Action menu.** Long-press (mobile) or hover-revealed `…` button (desktop) on a bubble opens a menu: **Copy** · **Select** · **Delete** (Delete shown only when `message.senderId === meId`).

**Long-press detection** — pointerdown starts a 500ms timer; cancel on pointerup or on pointermove past ~10px of slop. **Do not call `setPointerCapture`** — that would swallow the list's own scrolling. This is a timer, not a gesture machine; keep it that way.

**Selection mode.** Entering it (via menu → Select, or long-press when already in selection mode) swaps the chat header for a selection bar: count, actions, ✕ to exit. Plain taps then toggle. Desktop additionally: **shift-click** selects the inclusive range between the anchor and the clicked message; **ctrl/cmd-click** toggles one. Track a `selectionAnchorId` for ranges.

Bulk **Delete** is enabled only when every selected message is the viewer's own; otherwise disable it with a reason rather than silently deleting the subset. Bulk **Copy** joins bodies with newlines.

**Undo toast.** After a delete, show a toast for ~10s with an Undo action. Firing it calls `restoreMessages`. Dismiss on timeout or navigation. If a second delete happens while a toast is live, replace it (don't stack) — the previous deletion stays undoable via the API, just not via that toast.

### iOS specifics (CLAUDE.md "platform reality" — these go on the stage-gate checklist)
- Long-press on iOS Safari fires the **native callout / text-selection menu**. Bubbles need `-webkit-touch-callout: none` and `user-select: none` — which is exactly why **Copy lives in the action menu**, since suppressing this kills native text selection.
- The action sheet and selection bar must respect `env(safe-area-inset-*)`, matching the existing headers/tab bar in `App.tsx`.
- `touch-action: manipulation` on the new controls.
- Verify long-press doesn't conflict with the `MediaViewer` gesture layer on media bubbles.

## 5. Edge cases to handle explicitly

| Case | Expected |
|---|---|
| Optimistic message (no server id yet) | Not selectable, no delete affordance — there is nothing to delete server-side |
| Delete the newest message | Chat-list preview + unread badge update via the `['chats']` invalidation |
| Media message deleted | Message hides; `media` row, R2 objects and tags all **stay** (iceboxed wipe owns those). It correctly vanishes from the gallery because gallery joins on `messages.deleted_at IS NULL` |
| Media still `processing` when deleted | Processing completes normally; the `media.ready` frame arrives for a message no longer in cache — the handler must tolerate a miss, not throw |
| Restore lands far up the history | Reinserts in chronological (id) position, possibly off-screen. Accepted; no auto-scroll |
| Push already delivered | Cannot be recalled — a notification may sit on a lock screen after deletion. Document, don't fight it |
| Non-member / other user's message | `403`, nothing written |
| WS disconnected during delete | REST call is the source of truth; the reconnect refetch reflects it (CLAUDE.md #3 — never replay missed frames) |

## 6. Definition of done

- `npm run typecheck`, `npm run lint`, `npm run test` all green.
- Two-account manual/scripted check: A deletes → vanishes from B's open chat live; A undoes → reappears for B live; B cannot delete A's message (403); bulk-delete of 3 spanning a page boundary works; chat-list preview updates when the newest message goes.
- No migration added. No R2 deletion anywhere in the diff.
- BACKBONE §2 item 11 checked; §15 already carries the decisions.
