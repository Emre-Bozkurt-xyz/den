# Video transcode

Status: **BUILT** 2026-08-26, no migration. Verified in the api container
(where ffmpeg actually lives) — see §5.

Roadmap item 8's remaining piece (PROJECT.md §13; waveforms shipped
2026-07-22). This is a **correctness fix wearing a feature's clothes**, not a
nice-to-have.

## 1. What is actually broken today

`media/process.ts:processVideo` keeps the original bytes and reports:

```ts
r2Key: originalKey,   // no transcode, original bytes kept as-is
mime: 'video/mp4',    // best-effort; actual container may vary (iPhone .mov)
```

That comment is describing a bug. An iPhone records **HEVC/H.265 in a .mov
container**; the row says `video/mp4`, so every client is handed a `<video>`
source that claims to be something it is not. Two consequences:

- **Android and desktop Chrome frequently cannot decode HEVC.** A video sent
  from an iPhone can silently fail to play for most of the circle — a black
  box or a broken element, with nothing in the UI explaining why.
- Hard invariant 7 says *never trust client-declared mime* and verify after
  upload. We do verify the *upload*, then overwrite the verified answer with a
  hardcoded guess. The invariant is satisfied in letter and defeated in spirit.

Voice already solved exactly this problem, and the fix is to follow it. From
hard invariant 6: *"Voice is transcoded server-side to m4a/AAC — one storage
format, no playback-time format detection."* Video should say the same
sentence.

## 2. Target

**One stored format: H.264 (yuv420p) + AAC in MP4, `+faststart`.** It is the
only combination that plays natively in every browser Den supports, and
faststart moves the moov atom to the front so playback starts before the file
finishes downloading — which matters on a phone.

### 2.1 Remux when we can, transcode when we must

Always re-encoding would be simpler, and wrong: it burns CPU and throws away
quality on the many clips that are *already* H.264/AAC. So probe first:

| Input | Action | Cost |
|---|---|---|
| H.264 + AAC **and within the size cap** | **remux** — `-c copy -movflags +faststart` | ~seconds, lossless |
| anything else (HEVC, VP9, Opus…, or oversized) | **full transcode** | CPU-bound |

Both paths produce the same container and the same honest `video/mp4`.

⚠️ **The size cap is part of the remux condition, not just a transcode flag.**
A modern phone shoots 4K H.264 — precisely the input an "already the right
codec, wave it through" check lets past — and a couple of hundred megabytes in
a friend chat is a cost every person who scrolls past it pays. Remux is for
files that are already *fine*, not merely already H.264. This was wrong in the
first implementation and §5 explains how it was caught.

### 2.2 Bounds, because this runs inline

There is no job queue, and that is a deliberate standing decision (§14,
2026-07-20 — inline media processing specifically to avoid queue infra). A
2-minute transcode therefore occupies the request path.

- `preset veryfast`, `crf 23` — quality/speed balance suited to phone clips.
- Long edge capped at **1920px** (i.e. 1080p either way round); smaller videos
  are never upscaled, and portrait clips stay portrait.
- **`MAX_TRANSCODE_MS` (90s wall clock).** Past that, ffmpeg is killed and the
  original is kept with its **real, probed mime** rather than a guess. A long
  video that plays for some people is a worse outcome than one that plays for
  everyone, but it is a much better outcome than a blocked pipeline — and the
  honest mime at least lets the client fail visibly instead of silently.
- ⚠️ **`runFfmpeg` had no timeout at all** before this work, so a hung ffmpeg
  blocked the inline worker forever. Survivable for a poster frame that either
  works in a second or doesn't; not survivable for a transcode, where "wedged"
  and "still working" are indistinguishable without a clock. It now takes a
  `timeoutMs` and SIGKILLs after a SIGTERM grace period — ffmpeg mid-encode does
  not reliably honour a polite request. This is arguably the most important
  change in the whole feature.

### 2.3 The original

Deleted after the derived asset is confirmed uploaded — the same rule image and
voice already follow, and the reason the module header says "Video keeps its
original (no derived copy exists yet)" is precisely that no derived copy
existed. Now one does. ⚠️ Only delete on the transcode/remux path; the
timeout fallback keeps the original because it *is* the stored asset.

## 3. Mime honesty

`ProcessResult.mime` becomes whatever the file actually is:

- transcode or remux → `video/mp4` (true by construction)
- fallback → probed from the container, never assumed

This closes the invariant-7 gap in §1.

## 4. What this does NOT do

- No adaptive bitrate, no HLS, no multiple renditions. One file per video.
- No queue. If transcode time becomes a real problem, that is the moment to
  revisit the 2026-07-20 decision — not before, and not as a side effect of
  this.
- No re-processing of existing videos. A `scripts/backfill-video.ts` is the
  obvious follow-up (the waveform work set the precedent with
  `backfill-waveform.ts`), but existing rows keep playing exactly as well as
  they do today, so it is not urgent.

## 5. Verification

`scripts/probe-video.ts`, 2026-08-26 — **all 21 checks pass**. Fixtures are
generated by ffmpeg at run time rather than committed: a repo full of binary
test videos ages badly, and synthesizing them means the inputs are described by
the code that uses them.

⚠️ **Run it inside the api container**, which is where ffmpeg lives:

```bash
docker compose --env-file .env -f deploy/docker-compose.yml build api
docker compose --env-file .env -f deploy/docker-compose.yml \
  run --rm --no-deps -e R2_ENDPOINT=http://minio:9000 api \
  node server/dist/scripts/probe-video.js
```

| Case | What it proves |
|---|---|
| **HEVC/.mov (the iPhone case)** | out is h264+aac, mime is `video/mp4` **and now true**, a new key is stored, the original is deleted, poster survives, duration survives |
| Already H.264/AAC mp4 | takes the remux path, stays h264+aac |
| **Silent video** | transcodes without inventing an audio stream (`-c:a aac` against no audio is a classic ffmpeg failure; the code branches to `-an`) |
| **Portrait video** | stays taller than it is wide, and the row's dimensions match the stored file |
| **4K H.264 input** | long edge capped to 1920 |

**The bug the last case caught, and it is the interesting one.** The first
implementation applied the size cap only on the transcode path, so an
already-H.264 4K video was remuxed at full size. Worse than the bug: *the probe
originally asserted the behaviour the code had*, with a comment rationalising
why remux "deliberately" skips the cap. That is a test written to agree with
the implementation instead of the spec — it would have locked the bug in and
made it look intentional forever. The assertion now states what §2.2 promises,
and the code was changed to meet it.

### Not yet verified

- **iOS device gate:** playback of a Den-transcoded video in the installed PWA,
  and a video recorded *on* an iPhone surviving the round trip. The synthetic
  HEVC fixture proves the pipeline; only a real phone proves the real input.
- The **timeout fallback** path has not been exercised end to end — the
  `FfmpegTimeoutError` branch is reachable only by a video slow enough to
  exceed 90s, which no synthetic fixture here approaches. Its behaviour on
  paper: keep the original, probe an honest mime, keep the poster.
- No backfill. Existing video rows keep their original bytes and their
  hardcoded `video/mp4` label — they play exactly as well (or badly) as they
  did before. `scripts/backfill-video.ts` is the obvious follow-up, with
  `backfill-waveform.ts` as the precedent.
