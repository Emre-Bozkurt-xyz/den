# GIF attachments (Klipy)

**Status:** shipped behind the dev stack and **verified in a real browser** end-to-end (2026-08-14 — pick → send → `embed.ready` → renders from R2, absent from every gallery filter). Klipy's wire format is confirmed against the live API (§12). **Still outstanding:** the multi-account/non-member checks and the iOS device gate (§13). Off the §13 roadmap; pulled forward by owner decision, 2026-08-13.
**Executor note:** this doc is the brief. Read CLAUDE.md and PROJECT.md §5/§6/§7/§11/§12/§15, plus `docs/EMBEDS.md` §4 (the embed framework this is built on), before starting. `npm run typecheck && npm run lint && npm run test` green before any commit. Styling stays plain — the owner does a UI pass separately.

---

## 1. What we're building

A GIF button in the composer. Tap it → the composer row is **replaced** by a Klipy search panel → tap a GIF → **it sends immediately** as its own message. No caption, no tags, no staging, no confirm step.

GIFs **never appear in the gallery**, and that's structural rather than a filter (§4).

---

## 2. Provider: Klipy, and why not the obvious two

| Provider | Status as of 2026-08-13 |
|---|---|
| **Tenor** | **Dead.** Google froze new API registrations 2026-01-13 and discontinued the public API entirely on **2026-06-30**. Not an option — a key cannot be obtained. |
| **Giphy** | Beta keys are capped at **100 searches/hour app-wide**. Production status requires an application and a pricing negotiation. A single lively group-chat GIF war exhausts the beta cap, and the failure lands at the least explicable moment. |
| **Klipy** ✅ | Built by ex-Tenor people as a near drop-in Tenor replacement; adopted by WhatsApp, Discord, Canva, Figma, Outlook after the shutdown. Test key 100/hr; **production key is unlimited and free** (a Partner Panel form). Ads are explicitly optional and we decline them. Separate GIF / Sticker / Clip / **Meme** corpora. |

**Provider risk is real and contained twice over.** Klipy is young and ad-funded, and we're opting out of the ads — "lifetime free" is a promise, not a contract. But (a) the provider lives behind the existing resolver seam, so a swap is one server file, and (b) because bytes are snapshotted to R2 (§3), a provider dying breaks *new searches only* — every GIF already sent keeps working forever. The GIF-API landscape collapsed once already this year; design for it happening again.

---

## 3. Non-negotiables that apply here

- **Invariant 1 (auth = chat membership):** `assertMember` on the send path; the search proxy is `requireAuth`-gated so a stranger can't burn the API key.
- **Invariant 2 (media bytes never transit the API):** the client never uploads. The **server** fetches the GIF and puts it to R2 — a server-origin fetch, the same documented exception the Instagram resolver already uses for `og:image` (`docs/EMBEDS.md` §4.3).
- **Invariant 3 (server is truth):** the bytes are ours. A Klipy outage, URL change, or shutdown can never rot chat history.
- **Invariant 4 (one WS envelope):** reuse `embed.ready`. No new WS type is needed at all (§6).
- **Invariant 7 (never trust the client):** the client sends **only a Klipy slug**. The server re-fetches the item's metadata itself and derives every URL and dimension. A client-supplied URL is never stored or fetched.
- **Invariant 10 (no third-party JS/CDN in the client): no exception needed, and that is the point of the R2 decision.** Search results are proxied through Den's own API; GIF bytes are served from R2 like all other media. **The client never contacts klipy.com.** The required KLIPY attribution is self-hosted text/SVG in Den's own UI, not a remote asset or script.
- **§15 (call-readiness):** chat-scoped and member-count-agnostic. Never special-case DMs.
- DTOs live in `/shared`, imported by both sides.

---

## 4. Why an embed and not media

The `embeds` table already provides a provider seam, a mint→resolve→`embed.ready` lifecycle, an R2 snapshot key, and a `data` jsonb bag. Using it buys three things:

1. **Gallery exclusion is structural.** `GET /chats/:id/gallery` queries `media` joined to `messages` (`server/src/media/gallery.ts`). A row in `embeds` is *incapable* of appearing there. The media route would instead require an exclusion clause in every gallery query, forever, including ones not yet written.
2. **Tags, sensitivity, and the batch-tag panel never apply.** GIFs carry no tags by design, so `SENSITIVE_TAGS`/`sensitivityOf()` don't reach them (see §9 for what does the content-gating instead).
3. **Reply / react / delete / select already work** on any message, and `messages.kind='embed'` with a null body is correctly **not editable** (edit requires a non-empty body — `docs/MESSAGE_EDIT.md`). Nothing to edit on a bare GIF is the right answer, and it needs no new guard.

---

## 5. Data model — migration 014

> ⚠️ **Numbering:** PROJECT.md counts migrations 1-indexed while the files are 0-indexed. The current head is `server/drizzle/0012_steep_silver_surfer.sql`, which PROJECT.md calls "migration 013". So this is **migration 014, file `0013_*.sql`**.

**No new table.** Two CHECK constraints widen:

```sql
ALTER TABLE embeds DROP CONSTRAINT embeds_provider_check;
ALTER TABLE embeds ADD  CONSTRAINT embeds_provider_check
  CHECK (provider IN ('instagram','vault','klipy'));

ALTER TABLE embeds DROP CONSTRAINT embeds_action_type_check;
ALTER TABLE embeds ADD  CONSTRAINT embeds_action_type_check
  CHECK (action_type IN ('external','read','portal','inline'));
```

**`actionType='inline'` is a genuine addition, not a workaround** (D7): it means *this card **is** the content — there is nothing to open*. Provider-agnostic, and it's what stops `EmbedCard` from painting an external-link chip that would wrongly imply tapping leaves Den.

Column mapping for a Klipy row:

| Column | Value |
|---|---|
| `provider` | `'klipy'` |
| `providerRef` | the Klipy slug. The client supplies one (the only field it sends), but the resolver **overwrites it with the canonical form the API reports** — search results carry a per-response analytics suffix (§12) |
| `canonicalUrl` | `https://klipy.com/gifs/{canonical-slug}` — provenance and the failure fallback's link; never fetched for rendering. Null at mint time, set by the resolver |
| `title` | the GIF's title — used as `alt` text, so it is an **accessibility** field, not decoration |
| `subtitle` / `description` | `null` — there's no per-item author to credit; KLIPY attribution is picker-level branding (§9) |
| `thumbKey` | R2 key of the snapshot. **Reused as the content key** (D8) — for a GIF the "thumb" *is* the item. It's the one R2 key field the mapper presigns, so reuse costs no schema change; documented here so it doesn't read as a mistake. |
| `contentKind` | `'gif'` |
| `actionType` | `'inline'` |
| `data` | `{ width, height, mimeType }` — dimensions live here because `embeds` has no width/height column, and §8 *requires* them |

---

## 6. Send path — no new WS type

`docs/EMBEDS.md` §4.3 already anticipated this: *"when a send contains a recognized embeddable URL (**client sets an intent**, or server sniffs `body`)"*. The intent half was always the design; this is the first thing to use it.

**`MessageSendPayload` (`shared/src/ws.ts`) gains an optional `gif?: { slug: string }`.** In `server/src/ws.ts`'s `message.send` handler, alongside the existing `detectEmbedUrl` branch:

- `gif` present → `createEmbedMessage(chatId, userId, 'klipy', null, slug, null, replyToId)`, then the existing fire-and-forget `finalizeEmbed` → `embed.ready`. The URL argument is **null**, not `''`: only a slug is known at mint time, and the client's failure fallback renders `canonicalUrl ?? "…unavailable"`, which an empty string would slip past to paint an empty link.
- **`body` must be empty when `gif` is set** — reject otherwise. A GIF has no caption by owner decision (D4); silently dropping typed text would be worse than a 400.
- The `gif` intent takes precedence over body-sniffing; the two can't both apply since the body is empty.

Overloading `message.send` rather than adding a REST route or a new WS type is deliberate: it inherits the **entire** existing machinery — optimistic send, `reqId` dedup, room fanout, push, unread counts — with no parallel path to keep in sync.

### Search proxy (new REST routes)

```
GET /api/gifs/search?q=&page=     → { items: GifSearchItem[], hasNext: boolean }
GET /api/gifs/trending?page=      → same shape
```

Both `requireAuth`. `GifSearchItem` (`shared/src/api.ts`) is `{ slug, previewUrl, width, height, title }` — a **normalized** shape, never Klipy's raw response, so a provider swap doesn't reach the client.

> **The API key can only ever live server-side.** Klipy's native API puts the key **in the URL path** (`api.klipy.com/api/v1/{KEY}/gifs/search`), where it would leak through request URLs, referrers, logs, and devtools the instant a client touched it. The proxy isn't only about rate limits.

⚠️ `previewUrl` in search results **does** point at Klipy's CDN — this is the one place the client would contact a third party. See §9 for how the picker avoids that.

---

## 7. Server implementation

**`server/src/gifs/klipy.ts`** — the API client. `search`, `trending`, `byId`. Same hostile-input posture as `embeds/instagram.ts`: HTTPS only, host allowlist (`api.klipy.com` for the API, plus whatever CDN host the renditions resolve to — pin it once confirmed), hard timeout, response-size cap, no unchecked redirects.

**`server/src/routes/gifs.ts`** — thin proxy, `requireAuth`, normalizes to `GifSearchItem`, applies the rating ceiling (§9), and owns the cache (§10).

**`server/src/embeds/klipy.ts`** — the resolver. Registered in `embeds/registry.ts` as `klipy: resolveKlipy`. Given `providerRef` (the slug):

1. `byId(slug)` → metadata + renditions.
2. Pick a **pre-sized rendition** (~200–320px wide), never the full-size original.
3. Fetch bytes with the allowlist + size cap.
4. Re-encode through **sharp with `{ animated: true }`** → animated WebP.
5. `putObjectBuffer(embedKey(chatId, embedId, 'gif.webp'), buf, 'image/webp')` — the exact helpers `instagram.ts` already uses.
6. Return `{ thumbKey, title, contentKind: 'gif', actionType: 'inline', data: { width, height, mimeType: 'image/webp' } }`.

Any failure → `status='failed'` via the existing `finalizeEmbed` catch → the client's link fallback. Never a broken half-card.

**Animated WebP rather than MP4 (D6)** — three reasons: it reuses the existing sharp→R2 snapshot path *verbatim*; an `<img>` sidesteps every iOS autoplay-policy question that `<video>` would raise (`muted`+`playsInline` rules, gesture requirements); and MP4's size advantage is irrelevant at this scale (§10). If several looping WebPs prove slow on older iPhones at the device gate, MP4 + `<video>` is the documented fallback — and it's a resolver-and-renderer change only, no migration.

**`server/src/env.ts`** — `KLIPY_API_KEY` (optional) plus a `gifsEnabled` boolean gate, mirroring the existing `vaultLinkingEnabled` pattern. Gate off ⇒ `/gifs/*` returns 503 and the client hides the GIF button entirely (never a button that errors on tap).

---

## 8. Client

**`app/src/components/GifPanel.tsx`** — replaces the composer row wholesale (D5).

- Layout: `[←] [search input]` on the composer's row, results grid expanding below it (~45dvh).
- **Auto-focus the search input on open**, so the keyboard comes up and the panel — which now owns the bottom edge — composes with `--kb-inset` and `env(safe-area-inset-bottom)` exactly as `Composer` does. This is the whole reason for a full swap: three rounds of keyboard work (PROJECT.md §14, 2026-08-13) hang off the composer's own bottom padding, and a panel expanding *above* a live composer would fight that geometry, with two owners for one offset.
- **Must** call `useBackHandler(true, onClose, { escape: true })` — PROJECT.md §11 requires every overlay to register. Back/Escape closes the panel and restores the composer **with its draft intact** (the draft is never touched, which is the second reason not to repurpose the textarea — `draftCacheRef` survives the mobile/desktop remount and a half-typed message must not be at risk).
- Grid: **shortest-column masonry** (`lib/masonry.ts`, the gallery's packer), 2–5 columns from the measured width. A fixed row-based grid was tried first and rejected on sight (owner report, 2026-08-14): GIF aspect ratios vary wildly, so one portrait tile sets its row's height and every landscape tile beside it sits in a pool of dead space. Note `masonry.ts` is deliberately **not** CSS `column-count` — that reorders items away from relevance order. Every tile's box comes from the returned `width`/`height` before bytes load, so nothing reflows as images decode.
- Precedent to copy: `RecordingBar` already swaps the composer's contents for a mode, and `AttachmentSheet` already blurs the active element on open so the keyboard and a tall sheet don't fight over the same space.
- Picking sends immediately (§6) and closes the panel.

**Entry point** — a new GIF button in the composer's leading slot, beside the paperclip (`Composer.tsx` ~L593). Hidden in edit mode and while recording, exactly like the paperclip. A dedicated button beats turning the paperclip into a menu, which would add a tap to the far more common photo path. ⚠️ That row already holds attach + mic/send; check it at 360px.

**`EmbedCard.tsx`** — branch on `contentKind === 'gif'`:

- Bubble-less `<img>`, no provider badge, no external-link chip, not clickable.
- **The hardcoded `aspect-[9/16]` must not apply.** Reserve from `data.width/height` instead. GIFs are arbitrary aspect and mostly landscape; getting this wrong regresses chat scroll-to-bottom — the exact bug class `PreviewImage` was built to fix (PROJECT.md §14, 2026-07-22).
- While `status='processing'`, the client may reserve the placeholder box from the dimensions it *already has locally* from the search result. That's a display hint in component state, not stored or trusted data — it never reaches the server, so Invariant 7 is untouched.

This is honest about a cost: the "one shared renderer, zero new client code per provider" promise from `docs/EMBEDS.md` §1 does **not** fully survive GIFs. A GIF is inline content, not a card that links somewhere. The branch is small and `actionType='inline'` keeps it provider-agnostic, but it is a real branch.

---

## 9. Content rating, attribution, and the one third-party touch

**Rating is a per-user setting, not a server-pinned ceiling** (D9, owner decision 2026-08-13). Klipy's native API takes `rating` (`g` | `pg` | `pg-13` | `r`). Den adds one key to the existing settings bag:

```ts
// shared/src/api.ts — UserSettings
/** docs/GIFS.md §9 — ceiling applied to GIF search/trending requests.
 *  'off' omits Klipy's `rating` param entirely (no filtering). */
gifRating: 'g' | 'pg' | 'pg-13' | 'r' | 'off';
// DEFAULT_USER_SETTINGS: gifRating: 'pg-13'
```

**Zero migration** — `users.settings` (migration 013) is a jsonb bag built for exactly this, and `PATCH /me` already whitelists-and-merges. The control belongs under **Settings → Media & privacy**, beside `galleryShowSensitive`. The server reads the setting from the authenticated user's row and applies it to the outbound Klipy call; the client never sends a rating, so this stays consistent with Invariant 7.

Three consequences, all deliberate:

1. **The setting governs what you can *find*, not what others *see*.** A member with `off` can send an `r`-rated GIF into a chat where everyone else is on `pg-13`, and they'll all see it — exactly like any other media send. Den has no moderation by design (PROJECT.md §1, deliberate non-goals), and a closed friend circle is the trust model that makes that fine. Don't invent per-viewer GIF filtering on the render path; it would be the first content-gating Den has ever done to *received* content.
2. **This is the only content control the feature has.** GIFs aren't in the gallery and carry no tags, so the `nsfw`/`spoiler` model cannot reach them.
3. ⚠️ **Leave the Partner Panel's own content filters permissive.** They apply account-wide, above the API parameter — a restrictive setting there would silently override a user's `off` and make the setting look broken. The per-user value is the only place filtering should be decided.

Confirm with the test key whether omitting `rating` genuinely means unfiltered, or whether `r` is the effective maximum; if the latter, `'off'` maps to `r` and the union collapses by one.

**Attribution (ToS obligation, not optional).** The search field placeholder must read **"Search KLIPY"**, plus their "Powered by KLIPY" mark in the panel. Self-hosted text/SVG, so Invariant 10 holds. Confirm the exact required marks against the Partner Panel guidelines when the key is minted.

**The one third-party touch: search-result thumbnails.** Sent GIFs come from R2, but the *picker grid* renders `previewUrl`s from Klipy's CDN — so browsing the picker does contact them. Options, cheapest first:

- **(a) Accept it, scoped.** Contact happens only while the panel is open, never in chat history, and never for anyone but the person searching. Set `referrerpolicy="no-referrer"` on the grid's `<img>`s.
- **(b) Proxy previews through Den.** Zero client-to-Klipy contact, at the cost of VPS bandwidth for every thumbnail of every search — and a search grid is dozens of images per keystroke-batch. Expensive for a transient surface.

**Settled: (a)** — owner decision, 2026-08-13 (D10). This is the one place the feature knowingly touches Invariant 10, and it is scoped to the picker: contact happens only while the panel is open, only for the person searching, and never in chat history or for anyone reading it. (b) stays documented as the fallback if that ever needs tightening; it would change no stored data.

---

## 10. Rate limits, caching, and cost

**Keys.** Build against the **test key** (100/hr). Request the **production key** (unlimited, free) via the Partner Panel form before the circle uses it — the form wants a working integration, so this sequences naturally.

**Cache regardless of tier**, because it's also what makes the picker feel instant:

- Client: debounce **350ms**, minimum 2 characters.
- Server: in-memory TTL cache keyed `q|page|rating`, ~5 min for search, ~1 h for trending. This is the difference between surviving on the test key during development and not.

**R2 cost: negligible.** Storage is $0.015/GB-month with **zero egress**, and the free tier covers 10 GB-month / 1M Class A / 10M Class B. At ~200–400KB per stored WebP, a thousand sent GIFs a year is ~300MB — roughly 33,000 GIFs to leave the free tier. Reads are presigned GETs we already do for media.

---

## 11. Decisions (log these in PROJECT.md §14)

- **D1** — Klipy over Giphy/Tenor. Tenor is discontinued; Giphy's free tier caps at 100 searches/hour app-wide with paid production. Klipy's production tier is unlimited and free, and removes rate limiting as a design constraint entirely.
- **D2** — **Snapshot to R2, don't hotlink.** Costs pennies, needs no Invariant-10 exception, keeps every member's IP away from a third party, and makes sent GIFs immune to the provider vanishing — which the Tenor shutdown just proved is not hypothetical.
- **D3** — Embed, not media: gallery exclusion becomes structural rather than a filter every future query must remember.
- **D4** — **Picking is sending.** This deliberately reverses `docs/MEDIA_ATTACHMENTS.md` D-a ("picking no longer sends"). The codebase now carries both precedents, so the governing rule is stated here: **needs a caption → it stages; is itself the message → it sends.** A GIF has no caption and no tags, so there is nothing for a staging step to do.
- **D5** — Full composer swap, not a repurposed textarea: protects the draft cache, paste-detect, and edit mode, and leaves one owner for the bottom-edge keyboard offset.
- **D6** — Animated WebP via sharp, not MP4: reuses the existing snapshot path verbatim and avoids `<video>` autoplay policy on iOS. MP4 is the documented fallback if the device gate finds a perf problem.
- **D7** — New `actionType='inline'` ("this card is the content"), rather than branching the renderer on provider.
- **D8** — `thumbKey` reused as the content key; dimensions ride `data`.
- **D9** — **Rating is per-user (`UserSettings.gifRating`), defaulting to `pg-13`, and `'off'` (no filtering) is an available choice** — not a server-pinned ceiling. Owner's call: a fixed PG gate is the wrong default for a closed adult friend circle, but an unfiltered default is the wrong first impression, so the safe value ships and each person can turn it off for themselves. Costs no migration (`users.settings`, migration 013, exists for exactly this). The setting scopes what a member can *find*; it deliberately does **not** filter what they *receive* — see §9.
- **D11** — **The `'processing'` placeholder is shaped at mint time**, so other members see the GIF's real aspect immediately instead of a generic box that pops when `embed.ready` lands (owner report, 2026-08-14). `contentKind='gif'`/`actionType='inline'` are facts the server knows outright (the frame *is* a GIF pick). The dimensions are the feature's **only** client-declared value, accepted as a bounded cosmetic hint: clamped to an aspect between 1:3 and 3:1, normalized to a nominal width so no pixel claim is preserved, dropped entirely if malformed (falling back to a square), and overwritten by the resolver's measured values within the second. This does not weaken CLAUDE.md invariant 7, which governs what gets fetched, stored and served — a lie here can only make one placeholder briefly the wrong shape. Lives in `server/src/aspectHint.ts` with unit tests covering the abuse cases — **shared with the media upload path**, which has the identical problem and now uses the same clamp (docs/MEDIA_ATTACHMENTS.md §4.6).
- **D10** — Picker thumbnails load from Klipy's CDN (§9 option a) rather than being proxied. Accepted knowingly: it's scoped to the open panel and the searching user, never to chat history or to readers, and proxying dozens of thumbnails per keystroke-batch is a poor trade for a transient surface. Mitigated with `referrerpolicy="no-referrer"`. **Sent GIFs are unaffected — those always come from R2.**

  > **Note for whoever adds a CSP later:** Den currently sets **no `Content-Security-Policy` header anywhere** — not in `deploy/Caddyfile`, not in Fastify, not as an `index.html` meta. So there is no `img-src` to widen for this feature, and nothing here is blocked. If a CSP is ever introduced it must allow Klipy's CDN host for the picker grid — and separately, `docs/EMBEDS.md` §6.5's required `frame-src https://vault.ems-place.com` for the Vault portal appears never to have landed either. Both are the same one-line concern for a future CSP pass, not blockers for this feature.

---

## 12. Klipy's wire format — CONFIRMED against the live API (2026-08-13)

The schema is no longer a risk — it was probed directly and the client is written against the measured shape. Four findings, two of which changed the design:

**Surface:** the **native v1** API is what Den uses: `GET https://api.klipy.com/api/v1/{KEY}/gifs/{search|trending|<slug>}`, key in the path, params `q` / `page` / `per_page` / `rating`. Envelope: `{ result, data: { data: [...], current_page, per_page, has_next, meta } }`. The Tenor-compatibility surface (`/v2/search?key=`) also works and returns Tenor's `media_formats` + `dims` shapes, but it exposes strictly less and there is no reason to prefer it.

**Renditions are nested two levels — tier → format → asset:**

```
file: { hd|md|sm|xs : { gif|webp|jpg|mp4|webm : { url, width, height, size } } }
```

⚠️ **Tier names are not a reliable size ordering.** One measured item returned `hd.webp` at 71KB but `md.webp` and `sm.webp` both at 137KB, all three at the same 220px width. So `gifs/klipy.ts` flattens every animated rendition and **selects on declared `width`**, never on tier name: the narrowest ≥200px for the picker tile (below that it visibly upscales in the 2-column grid — the `xs` tier came back at 87px), and the narrowest ≥320px as the resolver's source (the stored cap, so anything larger is bytes fetched to discard). `jpg` is excluded because it's a still frame that would silently turn a GIF into a photo; `mp4`/`webm` because sharp can't read video and D6 stores animated WebP.

**⚠️ Search-result slugs carry a per-response suffix.** Every item in a single response shares the same tail (`…--kUCiOZb1O`), and it changes between responses — an analytics/share token, not part of the item's identity. Two identical back-to-back searches agree; searches minutes apart do not. Both the suffixed and the canonical form resolve via `gifs/{slug}`, and **the by-slug response reports the canonical form** (`goatplaybanjo-chat-4--kna8YY5fd` → `goatplaybanjo-chat-4`).

Consequence, and the reason `ResolvedEmbed` gained a `providerRef` override: the resolver stores **the canonical slug the API reports**, not the one it was asked with. Regex-stripping the suffix client-side was rejected — a legitimate slug may contain `--`, and guessing is unnecessary when the API states the answer. This keeps a dead session token out of `embeds.provider_ref`, where it would have outlived its meaning by years.

**The numeric `id` is not a lookup key** — `gifs/{id}` 404s. Slug is the only handle.

**Verified end-to-end** by running the real `searchGifs`/`gifBySlug` against the live API: 24 items per page, `hasNext` correct, previews 220–374px, source 498px, canonical slug stored. `rating=g` vs `rating=r` return different result sets, so the D9 ceiling is honoured; `'off'` omitting the param is accepted.

## 13. Verification (definition of done)

`npm run typecheck && npm run lint && npm run test` green, plus a scripted multi-account flow against the compose stack:

**Verified 2026-08-14**, driven through the real UI on the dev stack (single account):

- ✅ Pick a GIF → sends immediately → `embed.ready` upgrades it in place. The snapshot landed at `embeds/{chatId}/{embedId}/gif.webp`, and the served `thumbUrl` host is **the object store, not klipy.com** — the D2 invariant, observed rather than assumed.
- ✅ **Absent from `GET /chats/:id/gallery` under every filter** (none / `visual` / `image` / `video`) — the headline requirement — and the message carries zero `media` rows.
- ✅ Row shape: `provider='klipy'`, `status='ready'`, `content_kind='gif'`, `action_type='inline'`, `data={width,height,mimeType}`, and `provider_ref` stored **canonical** (`happy-cat-f7u`) with the search suffix correctly dropped (§12).
- ✅ Trending on open, debounced search, 24 items/page, `Load more`, and the required KLIPY placeholder + attribution all present; zero console errors throughout.
- ✅ A half-typed draft survives a picker round-trip untouched — the D5 claim, tested rather than asserted.

> ⚠️ **Bug found and fixed during this pass.** The search input lives inside the composer's `<form>` (§8 — the panel replaces the row but stays in the form to inherit its keyboard padding), so pressing **Enter triggered implicit form submission and sent the user's draft** from behind the open picker. `GifPanel` now `preventDefault`s Enter. Anything later added to that panel that can submit a form must do the same.

**Still to verify:**

- A second account receives the GIF, and a non-member never sees the embed; reply / react / delete / restore work on it; it is correctly not editable.
- Push preview and `ReplyPreview.preview` read sensibly for a body-less GIF message ("GIF").
- Resolver hostile-input: an unknown slug → `status='failed'` → link fallback; an oversized rendition is capped and fails cleanly, never OOMs the API process.
- The search proxy refuses unauthenticated callers; the API key appears in **no** client payload, URL, or log.
- Rating ceiling holds against a client attempting to pass its own.
- ⚠️ **iOS device gate** (PROJECT.md §12): animated-WebP decode in an installed PWA; several looping GIFs in a scrolling list (perf on older iPhones — same class as the existing blur-perf flag); the panel↔keyboard handoff and the panel's `--kb-inset` behaviour; the picker grid at 360px with the extra composer button.

---

## Bookkeeping (same change, not a follow-up)

- **PROJECT.md §5:** migration 014 — `embeds_provider_check` gains `'klipy'`, `embeds_action_type_check` gains `'inline'`; note the `data` shape for GIF rows and the `thumbKey`-as-content reuse.
- **PROJECT.md §5:** `UserSettings` gains `gifRating` — note that it needed **no migration**, which is the `users.settings` bag doing the job it was added for (§9/D9).
- **PROJECT.md §6:** `GET /gifs/search` and `GET /gifs/trending`; `PATCH /me`'s settings whitelist gains `gifRating`.
- **PROJECT.md §7:** `MessageSendPayload` gains the optional `gif` intent — note explicitly that **no new WS type was added**.
- **PROJECT.md §11:** `GifPanel` as a composer-replacing surface; the `EmbedCard` inline branch.
- **PROJECT.md §12:** the new iOS flags from §13 above.
- **PROJECT.md §13:** add as in-flight; **icebox** — Klipy stickers/clips/memes as extra picker tabs, GIF captions, GIF search history/favourites, proxying picker thumbnails (§9 option b).
- **PROJECT.md §14:** one entry covering D1–D9, with D2 (R2 over hotlinking) and D4 (the staging reversal) called out as the load-bearing ones.
