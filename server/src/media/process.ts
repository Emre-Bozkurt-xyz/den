/**
 * Media processing worker (BACKBONE §7). Runs right after upload-complete
 * verifies the object, behind the small in-process queue in pipeline.ts
 * (one video at a time, a few images/voice — audit 2026-11-18; before that
 * every complete started its own encode). The route that invokes this
 * already published the message with `media.status='processing'`, so
 * members see a placeholder, not silence, while this runs.
 *
 * ⚠️ Not idempotent on its own: it deletes `originalKey` once the derived
 * asset is uploaded. Only call it through service.ts `finalizeProcessing`,
 * which refuses rows that are no longer 'processing'.
 *
 * Per-kind behavior (§7 table):
 *   image — sharp: strip EXIF (incl. GPS) + auto-rotate, re-encode to WebP,
 *           400px WebP thumb. HEIC input decodes via libvips (Dockerfile.api
 *           installs libvips; verify HEIC on the real VPS per §14 Stage 0).
 *   video — ffmpeg to H.264/AAC in MP4 (docs/VIDEO_TRANSCODE.md), poster
 *           frame at t=0.5s, ffprobe duration/dimensions. Remuxed when the
 *           input is already H.264/AAC, fully re-encoded otherwise.
 *   voice — ffmpeg transcode to AAC/m4a (the one format that plays natively
 *           everywhere) + ffprobe duration.
 *
 * Originals superseded by a derived asset (image, voice, and now video) are
 * deleted from R2 after their replacement is confirmed uploaded, so we don't
 * pay to store both forever. ⚠️ Video is the one exception-with-an-exception:
 * when transcode AND the metadata-stripping fallback remux both fail, the
 * original IS the stored asset, so it must be kept.
 */
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import type { MediaKind } from '@den/shared';
import { FfmpegTimeoutError, probeCodecs, probeMedia, runFfmpeg } from './ffmpeg.js';
import { VIDEO_MAX_LONG_EDGE, videoFallbackRemuxPlan, videoRemuxArgs, videoTranscodeArgs, voiceTranscodeArgs } from './ffmpegArgs.js';
import { deleteObject, downloadObjectToFile, getObjectBuffer, mediaKey, putObjectBuffer, putObjectFile } from './r2.js';
import { pcmToPeaks } from './waveform.js';

export interface ProcessResult {
  r2Key: string; // may differ from the original key (image/voice are re-encoded)
  mime: string;
  sizeBytes: number;
  width: number | null;
  height: number | null;
  durationMs: number | null;
  thumbKey: string | null;
  waveform: number[] | null; // voice only (docs/VOICE_WAVEFORM.md)
}

export interface ProcessArgs {
  chatId: bigint;
  mediaId: bigint;
  kind: MediaKind;
  originalKey: string;
}

export async function processMedia(args: ProcessArgs): Promise<ProcessResult> {
  switch (args.kind) {
    case 'image':
      return processImage(args);
    case 'video':
      return processVideo(args);
    case 'voice':
      return processVoice(args);
  }
}

async function processImage({ chatId, mediaId, originalKey }: ProcessArgs): Promise<ProcessResult> {
  const orig = await getObjectBuffer(originalKey);

  // .rotate() with no args applies the EXIF orientation then normalizes it
  // away; sharp's output never carries input metadata unless withMetadata()
  // is called, so EXIF (incl. GPS) is stripped by construction (CLAUDE.md #6).
  const base = sharp(orig, { failOn: 'none' }).rotate();
  const meta = await base.metadata();
  // metadata() reports the *stored* (pre-rotation) dimensions. EXIF
  // orientations 5–8 are the 90° rotations (portrait phone shots), so after
  // .rotate() normalizes them the displayed image has width/height swapped
  // relative to the metadata — record the displayed orientation, which is
  // what the client's layout reservation needs.
  const sideways = (meta.orientation ?? 1) >= 5;
  const width = (sideways ? meta.height : meta.width) ?? null;
  const height = (sideways ? meta.width : meta.height) ?? null;

  const displayBuffer = await base.clone().webp({ quality: 90 }).toBuffer();
  const thumbBuffer = await sharp(orig, { failOn: 'none' })
    .rotate()
    .resize({ width: 400, height: 400, fit: 'inside', withoutEnlargement: true })
    .webp({ quality: 80 })
    .toBuffer();

  const displayKey = mediaKey(chatId, mediaId, 'display.webp');
  const thumbKey = mediaKey(chatId, mediaId, 'thumb.webp');
  await putObjectBuffer(displayKey, displayBuffer, 'image/webp');
  await putObjectBuffer(thumbKey, thumbBuffer, 'image/webp');
  if (displayKey !== originalKey) await deleteObject(originalKey);

  return {
    r2Key: displayKey,
    mime: 'image/webp',
    sizeBytes: displayBuffer.length,
    width,
    height,
    durationMs: null,
    thumbKey,
    waveform: null,
  };
}

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'den-media-'));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/**
 * Video (docs/VIDEO_TRANSCODE.md).
 *
 * ⚠️ What this replaced was a correctness bug, not a missing feature. The old
 * code kept the original bytes and hardcoded `mime: 'video/mp4'` — so an
 * iPhone's HEVC-in-.mov was announced to every client as MP4, and Android and
 * desktop Chrome, which mostly cannot decode HEVC, silently failed to play it.
 * Hard invariant 7 says never trust a client-declared mime; we were not
 * trusting the client, we were inventing one, which is worse.
 *
 * The rule is now voice's rule (hard invariant 6): ONE stored format —
 * H.264 + AAC in MP4 — so nothing downstream ever detects a format at
 * playback time.
 */
/** Wall clock for the encode. Past this the fallback below kicks in. */
const MAX_TRANSCODE_MS = 90_000;
/** Remuxing is a container rewrite, not an encode — it should never be slow. */
const MAX_REMUX_MS = 30_000;

async function processVideo({ chatId, mediaId, originalKey }: ProcessArgs): Promise<ProcessResult> {
  return withTempDir(async (dir) => {
    const inPath = join(dir, 'in');
    // Streamed to disk, never buffered: originals run up to 500MB.
    await downloadObjectToFile(originalKey, inPath);

    const codecs = await probeCodecs(inPath);
    const inProbe = await probeMedia(inPath);

    // Already the target codecs? Rewrite the container only: seconds instead
    // of minutes, and bit-identical video. `+faststart` still matters — it
    // moves the moov atom to the front so playback can start before the file
    // finishes downloading, which is the difference between "instant" and
    // "spinner" on a phone.
    //
    // ⚠️ The size cap applies to BOTH paths, which is why it is part of this
    // condition rather than only a transcode flag. A modern phone shoots 4K
    // H.264 — exactly the input that "already the right codec" would wave
    // through — and a couple of hundred megabytes in a friend chat is a real
    // cost to everyone who scrolls past it. Remux is for files that are
    // already fine, not merely already H.264.
    const longEdge = Math.max(inProbe.width ?? 0, inProbe.height ?? 0);
    const withinSizeCap = longEdge > 0 && longEdge <= VIDEO_MAX_LONG_EDGE;
    const canRemux =
      codecs.videoCodec === 'h264' &&
      (codecs.audioCodec === null || codecs.audioCodec === 'aac') &&
      withinSizeCap;

    // Every command here strips container metadata (ffmpegArgs.ts — iPhone
    // GPS lives there). `stored` is the file that ends up in R2 and the one
    // that gets probed; its `mime` is known by construction on the primary
    // path and probed on the fallback.
    const outPath = join(dir, 'out.mp4');
    let stored: { path: string; filename: string; mime: string | null } | null = null;
    try {
      if (canRemux) await runFfmpeg(videoRemuxArgs(inPath, outPath), MAX_REMUX_MS);
      else await runFfmpeg(videoTranscodeArgs(inPath, outPath, codecs.audioCodec !== null), MAX_TRANSCODE_MS);
      stored = { path: outPath, filename: 'video.mp4', mime: 'video/mp4' };
    } catch (e) {
      // ⚠️ Falling back rather than failing. A long or exotic video that plays
      // for some people is a worse outcome than one that plays for everyone,
      // but it is a far better outcome than a message stuck in 'processing'
      // forever. The mime below is then PROBED, never assumed — which is the
      // actual invariant-7 fix, and it holds on this path too.
      const step = canRemux ? 'remux' : 'transcode';
      if (e instanceof FfmpegTimeoutError) {
        console.warn(`video ${mediaId}: ${step} timed out after ${e.timeoutMs}ms — falling back`);
      } else {
        console.error(`video ${mediaId}: ${step} failed, falling back:`, e instanceof Error ? e.message : e);
      }
    }

    if (!stored) {
      // The fallback used to ship the untouched upload — GPS and all. Try a
      // metadata-stripping stream copy first: seconds, same codecs, so the
      // same playback compatibility as the original. Skipped when the primary
      // attempt already WAS a stream copy — the same copy failing twice tells
      // us nothing.
      const plan = canRemux ? null : videoFallbackRemuxPlan(inPath, dir, codecs.formatName, codecs.videoCodec);
      if (plan) {
        try {
          await runFfmpeg(plan.args, MAX_REMUX_MS);
          stored = { path: plan.outPath, filename: plan.filename, mime: null };
        } catch (e) {
          console.error(`video ${mediaId}: metadata-stripping fallback remux failed:`, e instanceof Error ? e.message : e);
        }
      }
    }

    if (!stored) {
      // Last resort: the raw original, container metadata included. Logged
      // loudly because it is the one path where an upload's embedded
      // location data can still reach other members.
      console.error(`video ${mediaId}: storing the ORIGINAL unmodified — container metadata NOT stripped`);
    }

    // Measure whatever we ACTUALLY ended up with. Transcoding bakes the
    // display-matrix rotation into the pixels and drops the side data, so the
    // input's dimensions can be the wrong way round for the output.
    const measuredPath = stored?.path ?? inPath;
    const probe = await probeMedia(measuredPath);

    // Poster from the same file, for the same reason.
    const posterPath = join(dir, 'poster.jpg');
    let thumbKey: string | null = null;
    try {
      await runFfmpeg(['-y', '-i', measuredPath, '-ss', '0.5', '-frames:v', '1', posterPath], 20_000);
      const posterBuffer = await readFile(posterPath);
      thumbKey = mediaKey(chatId, mediaId, 'poster.jpg');
      await putObjectBuffer(thumbKey, posterBuffer, 'image/jpeg');
    } catch {
      // Best-effort — a very short clip with no readable frame at 0.5s still
      // plays fine without a thumbnail.
      thumbKey = null;
    }

    if (!stored) {
      return {
        r2Key: originalKey,
        // Honest, not assumed. `mov,mp4,...` covers both; anything else is
        // reported as-is so the client can fail visibly rather than silently.
        mime: mimeForFormat(codecs.formatName),
        sizeBytes: (await stat(inPath)).size,
        width: probe.width,
        height: probe.height,
        durationMs: probe.durationMs,
        thumbKey,
        waveform: null,
      };
    }

    const mime = stored.mime ?? mimeForFormat((await probeCodecs(stored.path)).formatName);
    const outKey = mediaKey(chatId, mediaId, stored.filename);
    const sizeBytes = await putObjectFile(outKey, stored.path, mime);
    // Only once the replacement is confirmed uploaded — same order image and
    // voice use. ⚠️ The key guard is load-bearing: without it, a re-run
    // against an already-processed row (whose r2Key IS video.mp4) writes onto
    // that same key and then deletes it, leaving a 'ready' row pointing at
    // nothing (audit 2026-11-18).
    if (outKey !== originalKey) await deleteObject(originalKey);

    return {
      r2Key: outKey,
      mime,
      sizeBytes,
      width: probe.width,
      height: probe.height,
      durationMs: probe.durationMs,
      thumbKey,
      waveform: null,
    };
  });
}

/** Map ffprobe's container name to a mime for the fallback path. Conservative:
 *  anything unrecognized becomes the generic type rather than a confident lie. */
function mimeForFormat(formatName: string | null): string {
  if (!formatName) return 'application/octet-stream';
  const names = formatName.split(',').map((n) => n.trim());
  if (names.includes('mp4') || names.includes('mov')) return 'video/mp4';
  if (names.includes('webm')) return 'video/webm';
  if (names.includes('matroska')) return 'video/x-matroska';
  return 'video/' + (names[0] ?? 'mp4');
}

async function processVoice({ chatId, mediaId, originalKey }: ProcessArgs): Promise<ProcessResult> {
  return withTempDir(async (dir) => {
    const inPath = join(dir, 'in');
    const outPath = join(dir, 'out.m4a');
    await downloadObjectToFile(originalKey, inPath);

    // The normalization the Stage 0 voice PoC proved out (since removed):
    // MediaRecorder gives audio/mp4 on iOS Safari, audio/webm;opus on Chrome —
    // normalize both to mono 48kHz AAC/m4a, the one format that plays
    // natively everywhere (§7 THE cursed feature).
    // Container metadata is stripped as well (ffmpegArgs.ts): an iOS
    // recording is an MP4 container and can carry the same location atoms a
    // video does.
    await runFfmpeg(voiceTranscodeArgs(inPath, outPath));

    const probe = await probeMedia(outPath);
    const outBuffer = await readFile(outPath);

    // Waveform peaks from the transcoded audio (docs/VOICE_WAVEFORM.md):
    // decode to raw mono PCM at a low sample rate (8kHz is plenty — the bars
    // show loudness envelope, not frequency content) and bucket to RMS peaks.
    // Best-effort like the video poster: a voice note without a waveform
    // still plays fine, the client just shows its loading bars.
    let waveform: number[] | null = null;
    try {
      const pcmPath = join(dir, 'peaks.pcm');
      await runFfmpeg(['-y', '-i', outPath, '-ac', '1', '-ar', '8000', '-f', 's16le', pcmPath]);
      waveform = pcmToPeaks(await readFile(pcmPath));
    } catch {
      waveform = null;
    }

    const voiceKey = mediaKey(chatId, mediaId, 'voice.m4a');
    await putObjectBuffer(voiceKey, outBuffer, 'audio/mp4');
    if (voiceKey !== originalKey) await deleteObject(originalKey);

    return {
      r2Key: voiceKey,
      mime: 'audio/mp4',
      sizeBytes: outBuffer.length,
      width: null,
      height: null,
      durationMs: probe.durationMs,
      thumbKey: null,
      waveform,
    };
  });
}
