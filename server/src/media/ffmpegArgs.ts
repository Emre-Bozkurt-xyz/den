/**
 * ffmpeg argument lists for media/process.ts, kept dependency-free so the
 * flags that carry privacy weight are unit-testable (ffmpegArgs.test.ts)
 * without ffmpeg installed.
 *
 * ⚠️ `STRIP_METADATA` belongs on EVERY list that writes a stored file. ffmpeg
 * copies container/global metadata from input to output by default — for an
 * iPhone clip that includes `com.apple.quicktime.location.ISO6709`, i.e. GPS,
 * plus device make/model and capture time. Images already lose EXIF by
 * construction (sharp never writes input metadata); hard invariant 6 is about
 * GPS in images, and the same reasoning applies to video and voice containers
 * (audit fix 2026-11-18). `-map_chapters -1` drops chapter titles, the other
 * free-text channel that rides along with `-c copy`.
 *
 * Default stream selection (no `-map 0`) is kept on purpose: it takes one
 * video + one audio stream and drops data/timed-metadata tracks, which on
 * iPhone footage is exactly where extra location/orientation tracks live.
 *
 * ⚠️ The display-matrix rotation of a portrait phone video is stream SIDE
 * DATA, not metadata, in the ffmpeg shipped by Debian bookworm (5.1) — so
 * `-map_metadata -1` with `-c copy` should keep orientation. Very old ffmpeg
 * builds stored it as a `rotate` metadata tag instead; if a remuxed portrait
 * clip ever comes out sideways, that's why. probeMedia re-measures the
 * output, so stored width/height stay honest either way.
 */

import { join } from 'node:path';

export const STRIP_METADATA = ['-map_metadata', '-1', '-map_chapters', '-1'] as const;

export const VIDEO_MAX_LONG_EDGE = 1920;

/** Already H.264/AAC within the size cap: rewrite the container only. */
export function videoRemuxArgs(inPath: string, outPath: string): string[] {
  return ['-y', '-i', inPath, ...STRIP_METADATA, '-c', 'copy', '-movflags', '+faststart', outPath];
}

/** Full re-encode to H.264/AAC MP4 (docs/VIDEO_TRANSCODE.md). */
export function videoTranscodeArgs(inPath: string, outPath: string, hasAudio: boolean): string[] {
  return [
    '-y', '-i', inPath,
    ...STRIP_METADATA,
    '-c:v', 'libx264',
    '-preset', 'veryfast',
    '-crf', '23',
    // Some phone/screen-capture sources are 4:2:2 or 10-bit, which Safari and
    // older Android decoders refuse. yuv420p is the universally decodable choice.
    '-pix_fmt', 'yuv420p',
    // Cap the LONG edge, whichever way round the video is — a portrait clip
    // must not be squashed into a landscape box. `-2` keeps the other side
    // proportional and even (H.264 requires even dims).
    '-vf', `scale='if(gt(iw,ih),min(iw,${VIDEO_MAX_LONG_EDGE}),-2)':'if(gt(iw,ih),-2,min(ih,${VIDEO_MAX_LONG_EDGE}))'`,
    ...(hasAudio ? ['-c:a', 'aac', '-b:a', '128k'] : ['-an']),
    '-movflags', '+faststart',
    outPath,
  ];
}

export interface FallbackRemuxPlan {
  args: string[];
  /** Where `args` writes the remuxed file. */
  outPath: string;
  /** File name (under the media id's key prefix) the remuxed file is stored as. */
  filename: string;
}

/**
 * The transcode-failed/timed-out fallback used to ship the untouched upload,
 * GPS and all. This is the cheap middle ground: a stream-copy remux into the
 * SAME container family that only drops metadata — seconds, not minutes, and
 * playback compatibility identical to the original. Null when the container
 * isn't one we'd confidently remux into; the caller then keeps the raw
 * original and logs it.
 *
 * `hvc1` for HEVC: ffmpeg's mp4 muxer defaults to the `hev1` tag, which
 * Safari refuses to play — and iPhone HEVC is the single most likely input
 * to reach this fallback (long clips hitting the transcode cap).
 */
export function videoFallbackRemuxPlan(
  inPath: string,
  outDir: string,
  formatName: string | null,
  videoCodec: string | null,
): FallbackRemuxPlan | null {
  const names = (formatName ?? '').split(',').map((n) => n.trim());
  if (names.includes('mp4') || names.includes('mov')) {
    const out = join(outDir, 'fallback.mp4');
    return {
      outPath: out,
      args: [
        '-y', '-i', inPath,
        ...STRIP_METADATA,
        '-c', 'copy',
        ...(videoCodec === 'hevc' ? ['-tag:v', 'hvc1'] : []),
        '-movflags', '+faststart',
        '-f', 'mp4',
        out,
      ],
      filename: 'video.mp4',
    };
  }
  if (names.includes('webm')) {
    const out = join(outDir, 'fallback.webm');
    return { outPath: out, args: ['-y', '-i', inPath, ...STRIP_METADATA, '-c', 'copy', '-f', 'webm', out], filename: 'video.webm' };
  }
  return null;
}

/** Voice: normalize everything to mono 48kHz AAC/m4a (§7). */
export function voiceTranscodeArgs(inPath: string, outPath: string): string[] {
  return [
    '-y',
    '-i', inPath,
    ...STRIP_METADATA,
    '-vn',
    '-ac', '1',
    '-ar', '48000',
    '-c:a', 'aac', '-b:a', '96k',
    '-strict', 'experimental',
    '-movflags', '+faststart',
    outPath,
  ];
}
