/**
 * Media processing worker (BACKBONE §7). Runs inline, right after upload-
 * complete verifies the object — no job queue for MVP (closed friend-circle
 * volume doesn't warrant one; §14 doesn't call for one either). The route
 * that invokes this already flipped the message to visible with
 * `media.status='processing'`, so callers see a placeholder, not silence,
 * while this runs.
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
 * on the transcode-timeout fallback the original IS the stored asset, so it
 * must be kept.
 */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import type { MediaKind } from '@den/shared';
import { FfmpegTimeoutError, probeCodecs, probeMedia, runFfmpeg } from './ffmpeg.js';
import { deleteObject, getObjectBuffer, mediaKey, putObjectBuffer } from './r2.js';
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
const VIDEO_MAX_LONG_EDGE = 1920;
/** Wall clock for the encode. Past this the original is kept, honestly typed. */
const MAX_TRANSCODE_MS = 90_000;
/** Remuxing is a container rewrite, not an encode — it should never be slow. */
const MAX_REMUX_MS = 30_000;

async function processVideo({ chatId, mediaId, originalKey }: ProcessArgs): Promise<ProcessResult> {
  return withTempDir(async (dir) => {
    const orig = await getObjectBuffer(originalKey);
    const inPath = join(dir, 'in');
    await writeFile(inPath, orig);

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

    const outPath = join(dir, 'out.mp4');
    let transcoded = false;
    try {
      if (canRemux) {
        await runFfmpeg(
          ['-y', '-i', inPath, '-c', 'copy', '-movflags', '+faststart', outPath],
          MAX_REMUX_MS,
        );
      } else {
        await runFfmpeg(
          [
            '-y', '-i', inPath,
            '-c:v', 'libx264',
            '-preset', 'veryfast',
            '-crf', '23',
            // Some phone/screen-capture sources are 4:2:2 or 10-bit, which
            // Safari and older Android decoders refuse. yuv420p is the
            // universally decodable choice.
            '-pix_fmt', 'yuv420p',
            // Cap the LONG edge, whichever way round the video is — a portrait
            // clip must not be squashed into a landscape box. `-2` keeps the
            // other side proportional and even (H.264 requires even dims).
            '-vf', `scale='if(gt(iw,ih),min(iw,${VIDEO_MAX_LONG_EDGE}),-2)':'if(gt(iw,ih),-2,min(ih,${VIDEO_MAX_LONG_EDGE}))'`,
            ...(codecs.audioCodec ? ['-c:a', 'aac', '-b:a', '128k'] : ['-an']),
            '-movflags', '+faststart',
            outPath,
          ],
          MAX_TRANSCODE_MS,
        );
      }
      transcoded = true;
    } catch (e) {
      // ⚠️ Falling back rather than failing. A long or exotic video that plays
      // for some people is a worse outcome than one that plays for everyone,
      // but it is a far better outcome than a message stuck in 'processing'
      // forever. The mime below is then PROBED, never assumed — which is the
      // actual invariant-7 fix, and it holds on this path too.
      if (e instanceof FfmpegTimeoutError) {
        console.warn(`video ${mediaId}: transcode timed out after ${e.timeoutMs}ms — keeping the original`);
      } else {
        console.error(`video ${mediaId}: transcode failed, keeping the original:`, e instanceof Error ? e.message : e);
      }
      transcoded = false;
    }

    // Measure whatever we ACTUALLY ended up with. Transcoding bakes the
    // display-matrix rotation into the pixels and drops the side data, so the
    // input's dimensions can be the wrong way round for the output.
    const measuredPath = transcoded ? outPath : inPath;
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

    if (!transcoded) {
      return {
        r2Key: originalKey,
        // Honest, not assumed. `mov,mp4,...` covers both; anything else is
        // reported as-is so the client can fail visibly rather than silently.
        mime: mimeForFormat(codecs.formatName),
        sizeBytes: orig.length,
        width: probe.width,
        height: probe.height,
        durationMs: probe.durationMs,
        thumbKey,
        waveform: null,
      };
    }

    const outBuffer = await readFile(outPath);
    const outKey = mediaKey(chatId, mediaId, 'video.mp4');
    await putObjectBuffer(outKey, outBuffer, 'video/mp4');
    // Only once the replacement is confirmed uploaded — same order image and
    // voice already use.
    await deleteObject(originalKey);

    return {
      r2Key: outKey,
      mime: 'video/mp4', // true by construction now, not a guess
      sizeBytes: outBuffer.length,
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
    const orig = await getObjectBuffer(originalKey);
    const inPath = join(dir, 'in');
    const outPath = join(dir, 'out.m4a');
    await writeFile(inPath, orig);

    // Same normalization as the Stage 0 voice PoC (routes/voice-poc.ts):
    // MediaRecorder gives audio/mp4 on iOS Safari, audio/webm;opus on Chrome —
    // normalize both to mono 48kHz AAC/m4a, the one format that plays
    // natively everywhere (§7 THE cursed feature).
    await runFfmpeg([
      '-y',
      '-i', inPath,
      '-vn',
      '-ac', '1',
      '-ar', '48000',
      '-c:a', 'aac', '-b:a', '96k',
      '-strict', 'experimental',
      '-movflags', '+faststart',
      outPath,
    ]);

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
