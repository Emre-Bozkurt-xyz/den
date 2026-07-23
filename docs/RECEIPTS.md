# Delivery states & read receipts (sent / delivered / seen / failed)

**Status:** shipped 2026-07-23 — roadmap item 3 in `docs/PROJECT.md` §13 (receipts half; typing indicators stay on the roadmap, not built here).
**Executor note:** this doc is the brief. Read CLAUDE.md and PROJECT.md §5/§6/§7/§11 before starting. Work top-to-bottom; each phase leaves the app working. `npm run typecheck && npm run lint && npm run test` must be green before any commit.

## 1. What we're building

Per-message status feedback under bubbles, own messages only:

- **Sent** — the server persisted the message (the `message.new` echo confirms it). Small muted text under the sender's newest message only.
- **Delivered** — every *other* member's device has actually received the message (true device delivery, WhatsApp-style, per owner decision 2026-07-23 — not just "server got it"). Replaces "Sent" under the newest message.
- **Seen** — avatar icons, Messenger-style: each other member's small avatar sits under the newest of *my* messages they've read (watermark-based, so partial seen in groups falls out naturally). Max 3 avatars per message, then `+N`. In a **2-member chat** the marker renders as plain "Seen" text instead of an avatar — the only possible seer is the one other person, so identifying them is redundant (owner revision 2026-07-23; keyed on member count, not `isGroup`, same presentation-only precedent as DM display names). When ≥1 member has *effectively* seen the newest message (see §3), the Sent/Delivered text on it is suppressed.
- **Reply supersedes receipt** (owner revision 2026-07-23) — a member's own later message is proof they saw everything before it (in this app you can only compose from an open, visible chat, which fires markRead), so their seen marker is dropped when a later message of theirs is loaded, and such members count as seers for the status-text suppression (otherwise a stale "Delivered" would sit above their reply forever). Per-member, not chat-wide: in a group, B's reply says nothing about C, so C's read marker survives B replying.
- **Failed to send** — red text under **every** failed message (unlike Sent/Delivered/Seen, which each exist in at most one place). The bubble persists (today it silently vanishes); **tap retries**, long-press actions menu offers Discard. Client-only state — a failed message never reached the server, so it's gone on refresh. That's correct under "server is truth".

Sending state stays as-is (opacity-60 pending bubble, no text).

**Explicitly out of scope:** typing indicators (rest of roadmap item 3 — do not build), per-device receipt fan-out (per-user watermark is the unit), receipts on other people's messages, "Seen at <time>" timestamps, offline outbox/queued sends (failed+retry is the whole story).

## 2. Non-negotiables that apply here

- `assertMember` on the new route and on every WS ack item (hard invariant 1).
- New WS `type` values on the existing `WsEnvelope` only; nothing collides with reserved `call.*` prefixes (hard invariant 4).
- Server is truth: reconnect invalidates and refetches receipts; WS frames are hints (hard invariant 3).
- Never special-case DMs — a DM is a 2-member group; the "all others delivered" / avatar rules must work unmodified for both.
- Soft-deleted messages are excluded from any message-existence validation reads.
- DTOs in `/shared` only.

## 3. Semantics (the exact rules)

Per member per chat, two monotonic watermarks on `chat_members`:

- `last_read_message_id` (exists) — advanced by `POST /chats/:id/read`.
- `last_delivered_message_id` (new) — advanced by a client ack when a device receives a message (WS frame or refetch). Reading implies delivery: `/read` advances both.

Both updates are **guarded monotonic** (`WHERE watermark IS NULL OR watermark < :id`) — today `markRead` can move backwards from a stale client; fix that here since it becomes user-visible. Validate the message id exists in that chat (non-deleted) before writing. Broadcast a WS frame **only when a watermark actually advanced** (same "no phantom frame" rule as edit/delete).

Client-side derivation for my message `m` (BigInt id compares; ids are BIGINT-as-string):

- *Seen marker on `m` for member X*: `X.last_read >= m.id` AND `m` is the newest of my messages with `id <= X.last_read` (each member's marker sits at their watermark, clamped to my messages) AND X has **no loaded message newer than `m`** (reply supersedes receipt — their own reply already proves it). Renders as X's avatar; as plain "Seen" text in 2-member chats.
- *Status text*: only on my newest non-local message — `Delivered` if **all** other members have `last_delivered >= id`, else `Sent`; suppressed entirely once ≥1 member has *effectively seen* it (watermark `>= id` **or** a loaded message of theirs with a newer id — the latter matters because that member's marker is suppressed by the reply rule, so the rendered-avatar check alone would leave stale text).
- *Failed*: local id prefix `failed:` → red label on every such message.
- Marker *placement* stays watermark-only: a position derived from a member's own message would always sit below that same message and be suppressed by the reply rule — dead code by construction.

## 4. Backend

### 4.1 Migration 008 — delivered watermark

`server/src/db/schema.ts` `chatMembers`: add `lastDeliveredMessageId: bigint('last_delivered_message_id', { mode: 'bigint' })` (nullable, no FK — mirror `lastReadMessageId`, with a "Migration 008 (post-MVP, docs/RECEIPTS.md)" comment). `npm run db:generate` → additive `ALTER TABLE` only.

### 4.2 Shared types

`shared/src/ws.ts` — three new `WsType` entries + payloads:

```ts
// receipts (post-MVP, docs/RECEIPTS.md)
DeliveredAck: 'delivered.ack',        // client → server
MessageDelivered: 'message.delivered', // server → chat room
MessageRead: 'message.read',           // server → chat room

/** Client → server: these messages reached this device (WS frame received,
 *  or newest ids seen in a refetch after reconnect). Batched: one frame can
 *  ack many chats. Invalid/non-member items are skipped silently. */
export interface DeliveredAckPayload { items: { chatId: string; messageId: string }[] }
/** Server → room broadcasts, only when the watermark actually advanced. */
export interface MessageDeliveredPayload { chatId: string; userId: string; messageId: string }
export interface MessageReadPayload { chatId: string; userId: string; messageId: string }
```

`shared/src/api.ts`:

```ts
/** GET /chats/:id/receipts — every member's watermarks (viewer included;
 *  client ignores its own row). Nulls = never read/delivered anything. */
export interface ChatReceipt { userId: string; lastReadMessageId: string | null; lastDeliveredMessageId: string | null }
export interface ReceiptsResponse { receipts: ChatReceipt[] }
```

### 4.3 Service (`server/src/chat/service.ts`)

- Rework `markRead(chatId, userId, messageId): Promise<boolean>` — validate the id is a non-deleted message of this chat (else return false / validation error), monotonic `UPDATE … WHERE last_read_message_id IS NULL OR < :id`, return whether a row changed (`.returning()` or rowCount).
- New `markDelivered(chatId, userId, messageId): Promise<boolean>` — same shape against `lastDeliveredMessageId`.
- New `listReceipts(chatId): Promise<ChatReceipt[]>` — one select over `chat_members`.

### 4.4 Routes (`server/src/routes/chats.ts`)

- `POST /chats/:id/read` (existing): after `markRead` returns true → `app.io.to(chatRoom(chatId)).emit('ws', makeEnvelope(WsType.MessageRead, {…}))`; also call `markDelivered` and broadcast `MessageDelivered` if it advanced. `app.io` is already decorated; the route file already imports `chatRoom`.
- New `GET /chats/:id/receipts` — `requireAuth` + `assertMember`, returns `ReceiptsResponse`. Same handler shape as `/read`.

### 4.5 WS handler (`server/src/ws.ts`)

New case `WsType.DeliveredAck` → `handleDeliveredAck(io, userId, frame)`: for each item (cap the batch, e.g. 50): parse BigInts, `isMember` check (skip silently — no Error-frame spam for a fire-and-forget ack), `markDelivered`, broadcast `MessageDelivered` to `chatRoom(chatId)` only on advance. No reply frame on success.

## 5. Frontend

### 5.1 Receipts cache

- `app/src/lib/chats.ts`: add `fetchReceipts(chatId)`.
- New hook `app/src/hooks/useReceipts.ts`: plain query `['receipts', chatId]` → `ReceiptsResponse`, mounted by `ChatView`.
- `app/src/lib/realtime.tsx`:
  - Connect handler: also `invalidateQueries({ queryKey: ['receipts'] })` (reconnect = refetch, never replay).
  - `MessageDelivered` / `MessageRead` frames: `setQueryData(['receipts', chatId])`, replacing that user's watermark **only if the frame's id is newer** (frames can race; same monotonic rule client-side). On `MessageRead` where `userId === me`, also `invalidateQueries(['chats'])` — cross-device unread-badge sync for free.

### 5.2 Delivered acks (client → server)

In `realtime.tsx`:

- On `MessageNew` and `MediaReady` frames: emit `delivered.ack` for `{chatId, message.id}` (skip when the frame reconciled my own pending send — my own message needs no self-ack… actually ack anyway; server skips non-advances — simpler, no branch).
- After `['chats']` refetches (the `useChats` queryFn or a small effect watching its data): batch-ack every chat's `lastMessage.id` in one frame. This is what turns reconnect-after-offline into "Delivered" for senders.

### 5.3 Failed sends (`realtime.tsx`)

- New `failedRef: Map<reqId, {chatId, body, replyToId?, replyPreview?}>` storing send args; `sendMessage` registers it alongside `pendingRef`.
- `sendMessage` with no socket: insert the bubble directly as `failed:{reqId}` instead of silently no-oping.
- Per-send 10s timeout: rename the cached bubble id `pending:` → `failed:` (keep the `pendingRef` entry, updating its `tempId`, so a late `message.new` echo still reconciles and clears the failure).
- `WsType.Error` with a pending reqId: rename to `failed:` instead of deleting; drop the `pendingRef` entry (server definitively rejected), keep `failedRef`.
- Context gains `retrySend(failedId)` (remove failed bubble + resend stored args as a fresh send) and `discardFailed(failedId)`.
- Shared helper `isLocalId(id)` (`pending:` or `failed:` prefix) replacing the raw `startsWith('pending:')` checks — `byIdDesc` pinning, `MessageBlockRow`'s `pending` flag, selection/actions exclusions, and `ChatView`'s markRead guard all switch to it.

### 5.4 ChatView (`app/src/components/ChatView.tsx`)

- **Visibility-gate the markRead effect** (~line 270): only post when `document.visibilityState === 'visible'`, and re-run on `visibilitychange` (pattern already exists in the `clearChatNotifications` effect right below it). Backgrounded-tab "Seen" would now be a user-visible lie.
- Compute per-render from `useReceipts` + `messages` + `chat.members` (small helper, unit-testable, e.g. `app/src/lib/receipts.ts`):
  - `seenAvatars: Map<messageId, PublicUser[]>` per §3;
  - `status: { messageId, kind: 'sent' | 'delivered' } | null` per §3.
- Thread both into `MessageBlockRow` (resolve per-block in `RunGroup`; a stack uses its own contained message ids). Render as a below-block row, the same slot pattern as the reaction-pill row (`mt-0.5 flex justify-end`):
  - avatars: 16px rounded images (reuse the existing avatar rendering from `ChatList`), max 3 + `+N` in `text-[10px] text-text-muted`;
  - status text: `text-[10px] text-text-muted` ("Sent" / "Delivered");
  - failed: `text-[10px]` in the danger/destructive token, "Failed to send — tap to retry", tap → `retrySend`; the actions/focus menu for a failed message shows Discard only.
- Plain styling — no polish pass now (standing owner preference).

## 6. Docs & bookkeeping (same change, not a follow-up)

- PROJECT.md §5: `chat_members.last_delivered_message_id` + monotonic-watermark rule.
- PROJECT.md §6: `GET /chats/:id/receipts`; note `/read` now broadcasts.
- PROJECT.md §7: the three new WS types.
- PROJECT.md §13: split roadmap item 3 — receipts shipped, typing indicators remain.
- PROJECT.md §14: decision entry — true device-delivery semantics (owner call, 2026-07-23), Messenger-style avatar seen markers with `+N` overflow, all-others rule for Delivered, failed-send retry being client-only.

## 7. Verification (definition of done)

Scripted multi-account flow against the compose stack (socket.io-client + curl, Stage-2-script pattern):

1. **DM happy path:** A sends while B's socket is connected → A's newest shows Sent then Delivered (B's auto-ack); B `POST /read` → A gets `message.read`, avatar replaces the text. Older messages show nothing.
2. **Offline delivery:** B disconnected; A sends → stays Sent. B reconnects (refetch + batch ack) → A gets `message.delivered` without B opening the chat.
3. **Group partial:** 3 members; only C acks → A still shows Sent (all-others rule). B acks → Delivered. C reads → C's avatar on that message while B's avatar sits on an older message (watermark clamp). 5-member chat: 4 seers on one message renders 3 avatars + `+1`.
4. **Monotonic + validation:** `/read` and `delivered.ack` with an older id: no write, no broadcast. Foreign/garbage message id: rejected/skipped, no broadcast. Non-member ack: silently skipped, nothing leaks.
5. **Failed sends (manual/Playwright):** invalid send (oversized body) → bubble persists with red label; tap retry succeeds. Socket down → immediate failed bubble; retry after reconnect delivers. Refresh drops failed bubbles (expected).
6. **Cross-device:** my read on device 1 clears the unread badge on device 2 without a manual refetch.
7. `npm run typecheck && npm run lint && npm run test` green; unit tests for the `receipts.ts` derivation helper (watermark clamp, all-others, suppression rule) and monotonic service functions.

### iOS flags (for the device checklist — dev device is Android)

- `visibilitychange` gating of markRead in the installed PWA: iOS fires `pagehide`/freeze inconsistently — verify backgrounding the PWA stops read-marking and returning resumes it.
- Tap target of the "tap to retry" text (small text; ensure the whole failed block is tappable, `touch-action: manipulation`).
- Avatar-row layout under bubbles near the composer safe-area.

Commit granularity: `feat(receipts): migration + watermark services + WS/REST fan-out`, `feat(receipts): client acks + receipts cache`, `feat(receipts): status text, seen avatars, failed-send retry UI`, docs folded into the relevant commits.
