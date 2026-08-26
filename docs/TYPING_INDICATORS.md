# Typing indicators

Status: **BUILT** 2026-08-26, no migration. Server-verified against the compose
stack — see §5.

Roadmap item 3's remaining half (PROJECT.md §13; read receipts shipped
2026-07-23 as `docs/RECEIPTS.md`). Small by design: two WS types, no migration,
no REST, no media.

## 1. Shape

Ephemeral, in-memory, per-socket — like presence (`realtime/presence.ts`) and
unlike receipts. Nothing is persisted, and that is not a shortcut: a typing
state that outlived the tab it came from would be a lie, and hard invariant 3
("server is truth, client is a cache") has nothing to say here because there is
no truth to keep — the fact expires in seconds.

Two types added to the `WsType` registry:

| Type | Direction | Payload |
|---|---|---|
| `typing.update` | client → server | `{chatId, typing}` |
| `typing.state` | server → `chat:{id}` | `{chatId, userId, typing}` |

⚠️ **`assertMember` on every inbound frame.** The client supplies `chatId`, so
without it anyone could broadcast into — and learn about typing in — a chat
they are not in. That is hard invariant 1, and it applies to WS frames exactly
as it does to REST.

The echo goes to the chat room minus the sender (`socket.to(...)`, not
`io.to(...)`): you do not need to be told you are typing.

## 2. ⚠️ The stuck-indicator problem

The failure mode of every typing indicator is the same: someone starts typing,
their tab dies — crash, tunnel drop, phone sleeps, train tunnel — and everyone
else sees "Emre is typing…" forever. It is worse here than in most apps,
because Den's users are on phones that suspend aggressively.

Three defences, and all three are needed:

1. **Server-side expiry.** Each `typing: true` sets a ~6s timer per
   (socket, chat). If no refresh arrives, the server emits `typing: false`
   itself. This is the one that actually matters — it does not depend on the
   client being alive to say stop.
2. **Disconnect cleanup.** A socket disconnecting clears all of its typing
   states and emits the stops.
3. **Client-side floor.** The receiving client also expires an indicator it
   has not heard about in ~8s. Belt and braces for a dropped frame.

The client re-sends `typing: true` at most every ~3s while the user keeps
typing — half the server's expiry, so one dropped frame does not blink the
indicator off.

## 3. Client

- **Emit** from `Composer`'s existing text `onChange`. Throttled to one frame
  per 3s; a `typing: false` fires immediately on send, on clear, and on blur.
  ⚠️ Not on every keystroke — that is a frame per character to every member.
- **Render** in `ChatView`, in the same region as the existing receipt line so
  it cannot add height when it appears (the message list must not shift under
  the reader's thumb — the same rule the edited-indicator work settled on).
- Copy: `Alex is typing…`, `Alex and Sam are typing…`, `3 people are typing…`.
  Names come from chat members already in the client cache; no fetch.

## 4. What this does NOT do

- No "seen" or "recording voice" variants. One state, one meaning.
- No persistence, no history, no events in `security_events`.
- No typing state in the chat **list** — only inside an open chat. Showing it
  in the list would mean fanning keystroke-rate frames to every client for
  every chat, which is a real cost for a cosmetic gain.

## 5. Verification

`scripts/probe-typing.ts`, 2026-08-26 — **all 7 checks pass**. It drives three
real socket.io clients (two members and a non-member) rather than calling
functions, because every interesting property here is about what crosses the
wire and to whom.

| Check | Result |
|---|---|
| B receives A's `typing.state`, saying `true` | PASS |
| **A does NOT receive its own echo** | PASS |
| A non-member receives nothing | PASS |
| **A non-member cannot inject typing into a chat they're not in** | PASS |
| **The server emits `typing: false` by itself after the expiry, with A sending nothing** | PASS |
| A disconnect emits the stop well before the expiry would have | PASS |

The fifth row is the one this feature exists to get right, and the probe
earns it by having A go silent — standing in for a client that crashed, slept
or lost its tunnel mid-word. A test that politely sends `typing: false` proves
nothing about that case, which is the case every stuck-indicator bug is.

**The bug it caught:** `emitTypingState` was written with `io.to(room)`
instead of `socket.to(room)`, so the echo went back to the sender too. Not
merely wasted traffic — the client keys typers by userId and resolves names
from `chat.members`, so it would have rendered **"You are typing…"** on your
own screen. Invisible in any test that only checks the *receiver*.

### Not yet verified

- No browser pass: the throttle, the `useSyncExternalStore` snapshot identity,
  and the fixed-height line are all untested against a real keyboard.
- iOS: nothing device-specific here (no gestures, no media, no permissions),
  but the fixed-height line's behaviour with the keyboard open is worth a
  glance during the next device pass.
