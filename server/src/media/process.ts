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
 *   video — ffmpeg poster frame (t=0.5s) + ffprobe duration/dimensions. No
 *           transcoding in MVP — original bytes are kept as-is.
 *   voice — ffmpeg transcode to AAC/m4a (the one format that plays natively
 *           everywhere) + ffprobe duration.
 *
 * Originals superseded by a derived asset (image, voice) are deleted from R2
 * after their replacement is confirmed uploaded, so we don't pay to store
 * both forever. Video keeps its original (no derived copy exists yet).
 */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import type { MediaKind } from '@den/shared';
import { probeMedia, runFfmpeg } from './ffmpeg.js';
import { deleteObject, getObjectBuffer, mediaKey, putObjectBuffer } from './r2.js';

export interface ProcessResult {
  r2Key: string; // may differ from the original key (image/voice are re-encoded)
  mime: string;
  sizeBytes: number;
  width: number | null;
  height: number | null;
  durationMs: number | null;
  thumbKey: string | null;
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
    width: meta.width ?? null,
    height: meta.height ?? null,
    durationMs: null,
    thumbKey,
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

async function processVideo({ chatId, mediaId, originalKey }: ProcessArgs): Promise<ProcessResult> {
  return withTempDir(async (dir) => {
    const orig = await getObjectBuffer(originalKey);
    const inPath = join(dir, 'in');
    await writeFile(inPath, orig);

    const probe = await probeMedia(inPath);

    const posterPath = join(dir, 'poster.jpg');
    let thumbKey: string | null = null;
    try {
      await runFfmpeg(['-y', '-i', inPath, '-ss', '0.5', '-frames:v', '1', posterPath]);
      const posterBuffer = await readFile(posterPath);
      thumbKey = mediaKey(chatId, mediaId, 'poster.jpg');
      await putObjectBuffer(thumbKey, posterBuffer, 'image/jpeg');
    } catch {
      // Poster extraction is best-effort — a video with no readable frame at
      // 0.5s (very short clips) still plays fine without a thumbnail.
      thumbKey = null;
    }

    return {
      r2Key: originalKey, // MVP: no transcode, original bytes kept as-is (§7)
      mime: 'video/mp4', // best-effort; actual container may vary (iPhone .mov)
      sizeBytes: orig.length,
      width: probe.width,
      height: probe.height,
      durationMs: probe.durationMs,
      thumbKey,
    };
  });
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
    };
  });
}
