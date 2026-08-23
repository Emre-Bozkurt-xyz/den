# Notifications, second pass

**Status:** **built and verified server-side 2026-08-23** — no migration, no new dependency. 77 server + 38 app tests green, typecheck/lint clean, and the scripted three-account flow in §9 passes all 10 targeting scenarios plus decrypted-payload checks. **Still outstanding:** the browser pass on the two tap-to-open paths, and the iOS device gate (§9). Owner-requested, off the §13 roadmap — same posture as image paste / message edit / embeds / staged attachments / GIFs. Push itself shipped in the MVP (BACKBONE §8, hardware-verified on iOS 2026-07-21); this pass is about the three things it never actually did.
**Executor note:** read PROJECT.md §7 (WS protocol), §9 (auth/sessions/push), §11 (frontend architecture — navigation and the realtime layer), §12 (platform reality). `npm run typecheck && npm run lint && npm run test` green before any commit. Styling stays plain — the owner does a UI pass separately.

---

## 1. The three owner reports

1. *"Tapping a notification from a chat should send me to that chat, not just open the app."*
2. *"Opening a chat a notification came from should remove that notification."*
3. *"I sometimes don't get notifications, especially on the Chrome PWA."*

(2) turned out to be **already built** (`ChatView` → `clearChatNotifications` → the SW's `chat-opened` handler) and merely unverified. (1) was **scaffolded but inert**. (3) is four independent defects, and they are the substance of this pass.

---

## 2. Why notifications go missing — the diagnosis

### 2.1 The "is this user online?" test was answering a different question

`push/notify.ts` suppressed a push for any member with a socket in `chat:{id}`, on the documented reasoning that "every socket joins all of its user's chat rooms on connect, so *no socket in the room* is exactly *offline*."

The first half is true (`ws.ts` `joinOwnChatRooms`) and it is precisely what makes the second half false. Because a socket joins **every** room its user belongs to, membership of `chat:{id}` carries no information about that chat at all. The test reduces to **"does this user have any live socket anywhere?"** — a backgrounded Chrome PWA, a forgotten desktop tab, a phone whose radio hasn't yet dropped the connection. All of them suppress the push while the message lands silently in a cache nobody is looking at.

This is the main cause of report (3), and it is worst exactly where the owner noticed it: Chromium keeps a backgrounded installed PWA's page (and its socket) alive far longer than iOS does.

**Fix: report presence explicitly.** A new client→server WS type `presence.update` carries `{chatId | null, visible}`; the server keeps it on `socket.data.presence` and suppresses a push only for a socket that is **visible AND on that chat**. Everything else gets pushed.

The default matters: a socket that has never reported presence (an older client, a socket mid-handshake) counts as **not active**, so it gets a push. This whole feature fails toward notifying, and clear-on-open (§4) cleans up the false positives. The opposite default is what we are fixing.

**D1 — a foreground app on a *different* chat still gets an OS notification.** Owner call. It is what Discord/WhatsApp do, it is self-correcting (opening that chat clears it), and the alternative re-introduces a weaker version of the same bug: "the app is open somewhere" would again be standing in for "the user has seen this."

### 2.2 A tagged notification replaces its predecessor silently

`sw.ts` sets `tag: chat-${chatId}` so a chat's notifications collapse into one. Without `renotify: true`, a replacement on Chromium updates the tray entry with **no sound, no vibration, no banner** — messages 2..N of a burst are invisible unless you happen to look. Reads exactly as "I didn't get a notification."

**Fix: `renotify: true`.** Requires `tag`, which we already set. ⚠️ iOS support is uneven — flag for the device gate.

### 2.3 Nothing re-syncs a rotated subscription

There is no `pushsubscriptionchange` handler, and nothing re-POSTs an existing subscription at startup. When a push service rotates an endpoint, or a `410` prune races a reinstall, that device goes **permanently silent** until someone happens to tap "Enable notifications" again. A slow-onset, per-device failure — which is what "sometimes" usually means.

**Fix, two halves.** (a) A `pushsubscriptionchange` handler in the SW that re-subscribes and POSTs the new subscription. (b) `syncPushSubscription()` at app start: if permission is already `granted` **and** a subscription already exists, re-POST it. `onConflictDoUpdate` on `endpoint` makes that idempotent.

**D2 — the startup sync never prompts and never subscribes.** It only re-registers a subscription the browser already holds. Creating one requires `Notification.requestPermission()`, which on iOS must come from a real user gesture (PROJECT.md §12) — so the gestureless path is deliberately incapable of reaching it. `NotificationsSection`'s button stays the only way to *grant*.

### 2.4 Delivery hints were never set, and failures were invisible

No `urgency`, no `TTL`, and `sendOne` swallowed every non-404/410 error silently.

**Fix:** `urgency: 'high'` (FCM is free to batch/delay `normal`-urgency pushes while a device is dozing — a chat message is exactly what high urgency is for) and `TTL: 12h` (a day-old "hey" is noise, and a dead subscription shouldn't sit in a queue for the library default of four weeks). Log every non-prune failure at `warn`.

---

## 3. Deep-link (report 1)

The payload's `url` was hardcoded `'/'`, so `notificationclick`'s `client.navigate('/')` was a **same-URL navigation — a full reload of the PWA** that lands on the chat list. Two paths, deliberately different:

- **App already running:** focus the client and `postMessage({type:'open-chat', chatId})`. `App` resolves the `ChatSummary` (cache first, then a `fetchChats()` refetch — the exact fallback `jumpToMessage` already uses) and calls `openChat`. **No navigation, no reload**, so drafts, staged attachments and scroll position survive.
- **Nothing running:** `openWindow('/?chat=<id>')`, and `App` consumes the param on mount, then `history.replaceState`s back to `/` so a refresh doesn't re-trigger it — the same consume-once shape as the Web Share Target handler that already lives there.

**D3 — `?chat=` is a launch parameter, not a route.** Den has no router (PROJECT.md §11) and this pass is not the place to grow one. The URL is wiped the moment it is read; `View` stays the single source of truth.

---

## 4. Clear-on-open (report 2)

Already implemented; unchanged except that the SW now also refreshes the app badge after closing (§5). Worth re-stating why it is best-effort: `navigator.serviceWorker.controller` is `null` on a first-ever load, and programmatic dismissal via `getNotifications()` has historically been unreliable in installed iOS PWAs. ⚠️ Device gate.

---

## 5. App badge

`navigator.setAppBadge()` — supported on Android/desktop Chromium PWAs and iOS 16.4+ installed PWAs (the same floor push already requires).

**D4 — the badge counts *chats with something waiting*, not messages.** Two writers have to agree on it and only one of them can count messages. The client sets it from the `['chats']` query (`unreadCount > 0`); the SW sets it from `getNotifications().length`, which — given the per-chat `tag` — is the same unit. A message count would need the server to compute per-recipient unread totals and ship them in the payload, for a number the two writers would still disagree about between a push and the next `['chats']` refetch.

---

## 6. Payload

PROJECT.md §9 documents `{chatId, chatName, senderName, preview}`. The code sent `{chatId, senderName, preview, url}` — **`chatName` was never populated**, so every notification's title was the literal string `Den`. Now correct, and per-recipient:

| | title | body |
|---|---|---|
| DM | sender's display name | preview |
| Group | group name (or members' names, **excluding the recipient**) | `Sender: preview` |

Per-recipient means one payload per target user rather than one per send — a fallback group name shouldn't list you in your own notification. Subscriptions are already grouped by user, so this costs one extra `users` lookup per notified send, not per subscription.

---

## 7. Files

```
shared/src/ws.ts                  + WsType.PresenceUpdate, PresenceUpdatePayload
server/src/ws.ts                  + presence.update handler (assertMember-gated)
server/src/push/notify.ts           presence-aware targeting, per-recipient payload,
                                    urgency/TTL, deep-link url, failure logging
server/src/routes/push.ts           urgency/TTL on the debug send
app/src/lib/vapid.ts              + base64url to Uint8Array, shared by app and SW
app/src/lib/push.ts                 syncPushSubscription(); uses lib/vapid
app/src/lib/pwa.ts                  calls syncPushSubscription() after registration
app/src/lib/realtime.tsx          + setActiveChat() on the context; emits presence
app/src/components/ChatView.tsx     reports itself as the active chat
app/src/App.tsx                     ?chat= cold start, open-chat message, badge
app/src/sw.ts                       renotify, deep-link click, pushsubscriptionchange,
                                    badge upkeep
```

No migration. No new dependency.

---

## 8. Invariants this pass touches

- **Invariant 1 (auth = chat membership).** `presence.update` is not a subscription — no data flows back and a false claim cannot leak anything, since `notifyChatMembers` only ever consults presence for users who are already members. It is `assertMember`-gated anyway: the invariant is worth more than one indexed lookup per chat switch, and presence updates are rare (chat open/close, visibility edges).
- **Invariant 3 (server is truth).** Presence is per-socket, in-memory, and deliberately disposable — a reconnect re-reports it, and losing it degrades to "send the push," which is the safe direction.
- **Invariant 4 (one envelope).** `presence.update` is a new `type` on the existing `WsEnvelope`. No side-channel.
- **Reserved prefixes.** `presence.*` is not `call.signal.*` / `call.state.*`. Untouched.

---

## 9. Verification

**Done, 2026-08-23.** `npm run typecheck && npm run lint && npm run test` — clean, 77 server + 38 app tests.

Scripted three-account flow (alice/bob/carol) against a throwaway `den_notiftest` database on the compose Postgres, with the API run from source and a **fake HTTPS push service** registered as bob's subscription endpoint. That makes "did the server attempt a push, and what was in it" directly observable: the endpoint is a real subscription with a real P-256 keypair, so the payload can be decrypted (RFC 8188 `aes128gcm` + RFC 8291) rather than merely counted.

Targeting — all pass, and the first line is the bug:

| scenario | pushes to bob |
|---|---|
| B online, never reported presence *(the old code sent nothing here)* | 1 ✓ |
| B foreground **on** this chat | 0 ✓ |
| B backgrounded while on this chat (screen off, socket still up) | 1 ✓ |
| B foreground on a **different** chat (D1) | 1 ✓ |
| B foreground on the chat list (`chatId: null`) | 1 ✓ |
| B claims a chat it is not a member of → claim rejected, still notified | 1 ✓ |
| B watching the group, message lands in the group | 0 ✓ |
| B disconnected entirely (presence died with the socket) | 1 ✓ |
| B reconnected, presence not yet re-reported | 1 ✓ |
| B re-reported presence after reconnect | 0 ✓ |

The sender received 0 pushes in every scenario (alice holds her own subscription throughout).

Decrypted payloads, confirming §3 and §6:

```
DM             {"chatId":"1","chatName":null,          "senderName":"ALICE","preview":"…","url":"/?chat=1"}
named group    {"chatId":"2","chatName":"The Den",     "senderName":"ALICE","preview":"…","url":"/?chat=2"}
unnamed group  {"chatId":"4","chatName":"ALICE, CAROL","senderName":"ALICE","preview":"…","url":"/?chat=4"}
                                        ↑ recipient (BOB) correctly absent from their own notification
```

…and the headers from §2.4 on every send: `urgency: high`, `TTL: 43200`, `topic: chat-{id}`.

The script lives in the session scratchpad rather than the repo — it needs a throwaway database, a self-signed cert and `NODE_TLS_REJECT_UNAUTHORIZED=0` on the server, none of which belong in `server/src/scripts/`.

**Still outstanding — browser pass:** tap a notification cold → lands in the right chat; tap with the app running → lands in the right chat *without* a reload (type a draft first and check it survives).

⚠️ **iOS device gate** (PROJECT.md §12) — this pass's flagged items:
- `renotify` on WebKit (§2.2) — the burst case is the one to watch.
- `getNotifications()`-based dismissal in an installed PWA (§4), historically unreliable.
- `setAppBadge` from the SW (§5) vs. from the page.
- `notificationclick` → `clients.matchAll` finding a suspended-but-alive PWA client: the branch chosen there decides whether the user gets the fast in-app path or a cold `openWindow`.
- The whole point of §2.1 is that iOS suspends aggressively, so iOS should now receive **more** notifications than before. Confirm that is what happens, and that it isn't duplicative.
