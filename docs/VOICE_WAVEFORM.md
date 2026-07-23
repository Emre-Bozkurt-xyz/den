# Server-computed voice waveforms

**Status:** shipped 2026-07-22 — the waveform half of §13 roadmap item 8 ("server-side waveform peaks"), pulled forward on owner request. The video-transcode half of that item stays on the roadmap.

## 1. What we're building

Voice-message bubbles render the **real** waveform the moment they load. Before this, the waveform was a client-side facade: a deterministic fake bar pattern seeded from the media id, swapped for real peaks only after first play fetched and decoded the whole audio file (`app/src/lib/waveform.ts`, UI_REVAMP UI-7). The owner's call: a loading indicator is fine, a filled-in facade is not.

## 2. Design

- **Compute at processing time.** `processVoice` (server/src/media/process.ts) already has the transcoded m4a in a temp dir. One extra ffmpeg pass decodes it to raw mono s16le PCM at 8kHz (the bars show a loudness envelope, not frequency content — 8kHz is plenty and keeps the buffer tiny), then `pcmToPeaks` (server/src/media/waveform.ts) buckets it into 44 per-bucket **RMS** values — the same algorithm the client decoder used (RMS ≈ perceived loudness; peak-absolute reads as consonant spikes) — normalized to the loudest bucket, quantized to ints 0–255. Best-effort like the video poster: on failure the row just stores null.
- **Store on the row.** `media.waveform` (jsonb, nullable, voice only) — migration 0007. 44 small ints per voice note; no separate table, no extra fetch.
- **Ship in the DTO.** `MediaInfo.waveform: number[] | null` (`/shared`). Bar count is `VOICE_WAVEFORM_BARS = 44` in `/shared` so server (compute) and client (render) can never drift.
- **Client renders it directly.** `VoiceMessage` dequantizes (`v/255`) and draws — zero audio fetched to show bars. Rows without stored peaks show an **honest loading state**: uniform hairline bars (all zeros through the existing `BAR_MIN_SCALE` floor), unmistakably "no data", same bar count so the handoff never changes layout. The fake `placeholderPeaks` pattern is deleted.
- **Legacy self-heal.** The client-side decode path (`lib/waveform.ts`) survives as a fallback only: a row with `waveform: null` decodes real peaks on first play, exactly as before. It never draws fake bars.
- **Backfill.** `server/src/scripts/backfill-waveform.ts` — ready voice rows with `waveform IS NULL`: download m4a from R2 → same ffmpeg PCM pass → `pcmToPeaks` → write. Dry-run default, `--apply` to write (same pattern as `backfill-dims.ts`). After it runs, the fallback path is effectively dead code kept as insurance.

## 3. Non-negotiables that applied

- DTO change lives in `/shared` only; no second envelope, no new endpoints — the peaks ride the existing `MediaInfo`.
- New migration, never editing applied ones; PROJECT.md §5 updated in the same change.
- Media bytes still never transit the API server for *serving* — the backfill/processing reads from R2 server-side, which was always the processing posture (invariant 2 is about the client upload/download path).

## 4. Verification

- `npm run typecheck && npm run lint && npm run test` green.
- Compose-stack flow: send a voice note → bubble shows real bars immediately on a cold reload (no play needed); legacy row (pre-backfill) shows hairline loading bars, fills in on play; run backfill → shows real bars on reload.
- ⚠️ iOS note: nothing here touches the gesture-sensitive paths — `audio.play()` stays synchronous in the click handler; the OfflineAudioContext fallback is unchanged. Standing checklist item: confirm voice bubbles on iPhone PWA show real bars without playing.
