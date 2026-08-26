/**
 * ffmpeg/ffprobe process wrappers, shared by the voice PoC (routes/voice-poc.ts)
 * and the real Stage 3 worker (media/process.ts). Both spawn the CLI rather
 * than a binding — ffmpeg's on PATH in the Docker image (Dockerfile.api) and
 * expected on PATH for local dev (BACKBONE §14 Stage 0 gate).
 */
import { spawn } from 'node:child_process';

/** Thrown when `runFfmpeg` killed the process for exceeding `timeoutMs`.
 *  Distinct from a normal failure because callers can fall back rather than
 *  fail — a transcode that ran too long still has a usable original. */
export class FfmpegTimeoutError extends Error {
  constructor(readonly timeoutMs: number) {
    super(`ffmpeg exceeded ${timeoutMs}ms and was killed`);
    this.name = 'FfmpegTimeoutError';
  }
}

/**
 * Run ffmpeg to completion.
 *
 * ⚠️ `timeoutMs` is not optional in spirit. Media processing runs INLINE — no
 * job queue, by standing decision (§14, 2026-07-20) — so a wedged ffmpeg does
 * not merely fail slowly, it occupies the worker forever. That was survivable
 * while the only use was a poster frame that either works in a second or
 * doesn't; a transcode can legitimately run for a minute, which makes "wedged"
 * and "still working" indistinguishable without a clock.
 *
 * SIGKILL follows SIGTERM after a grace period: ffmpeg mid-encode does not
 * always honour a polite request.
 */
export async function runFfmpeg(args: string[], timeoutMs?: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const ff = spawn('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    let timedOut = false;

    const timer = timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          ff.kill('SIGTERM');
          setTimeout(() => ff.kill('SIGKILL'), 2000).unref?.();
        }, timeoutMs)
      : null;
    timer?.unref?.();

    ff.stderr.on('data', (d) => (stderr += d.toString()));
    ff.on('error', (e) => {
      if (timer) clearTimeout(timer);
      reject(new Error(`ffmpeg spawn failed: ${e.message}`));
    });
    ff.on('close', (code) => {
      if (timer) clearTimeout(timer);
      if (timedOut) return reject(new FfmpegTimeoutError(timeoutMs!));
      if (code === 0) return resolve();
      reject(new Error(`ffmpeg exited ${code}: ${stderr.slice(-500)}`));
    });
  });
}

export interface CodecInfo {
  /** e.g. 'h264', 'hevc', 'vp9'. Null when there is no video stream. */
  videoCodec: string | null;
  /** e.g. 'aac', 'opus'. Null when the file has no audio at all. */
  audioCodec: string | null;
  /** Container format names ffprobe reports, e.g. 'mov,mp4,m4a,3gp,3g2,mj2'. */
  formatName: string | null;
}

/**
 * What codecs are actually inside? This is the question `processVideo` has to
 * answer before it can decide between a cheap remux and a full re-encode
 * (docs/VIDEO_TRANSCODE.md §2.1) — and it is the question the old code never
 * asked, which is how every video ended up labelled `video/mp4` regardless of
 * what it was.
 */
export async function probeCodecs(path: string): Promise<CodecInfo> {
  const stdout = await new Promise<string>((resolve, reject) => {
    const args = [
      '-v', 'error',
      '-show_entries', 'stream=codec_type,codec_name',
      '-show_entries', 'format=format_name',
      '-of', 'json',
      path,
    ];
    const p = spawn('ffprobe', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    p.stdout.on('data', (d) => (out += d.toString()));
    p.stderr.on('data', (d) => (err += d.toString()));
    p.on('error', (e) => reject(new Error(`ffprobe spawn failed: ${e.message}`)));
    p.on('close', (code) =>
      code === 0 ? resolve(out) : reject(new Error(`ffprobe exited ${code}: ${err.slice(-500)}`)),
    );
  });

  const parsed = JSON.parse(stdout) as {
    streams?: { codec_type?: string; codec_name?: string }[];
    format?: { format_name?: string };
  };
  const streams = parsed.streams ?? [];
  return {
    videoCodec: streams.find((s) => s.codec_type === 'video')?.codec_name ?? null,
    audioCodec: streams.find((s) => s.codec_type === 'audio')?.codec_name ?? null,
    formatName: parsed.format?.format_name ?? null,
  };
}

export interface ProbeResult {
  durationMs: number | null;
  width: number | null;
  height: number | null;
}

/** ffprobe the primary video stream (if any) + container duration. */
export async function probeMedia(path: string): Promise<ProbeResult> {
  const stdout = await new Promise<string>((resolve, reject) => {
    const args = [
      '-v', 'error',
      '-select_streams', 'v:0',
      '-show_entries', 'stream=width,height:stream_side_data=rotation',
      '-show_entries', 'format=duration',
      '-of', 'json',
      path,
    ];
    const p = spawn('ffprobe', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    p.stdout.on('data', (d) => (out += d.toString()));
    p.stderr.on('data', (d) => (err += d.toString()));
    p.on('error', (e) => reject(new Error(`ffprobe spawn failed: ${e.message}`)));
    p.on('close', (code) => (code === 0 ? resolve(out) : reject(new Error(`ffprobe exited ${code}: ${err.slice(-500)}`))));
  });

  const parsed = JSON.parse(stdout) as {
    streams?: { width?: number; height?: number; side_data_list?: { rotation?: number }[] }[];
    format?: { duration?: string };
  };
  const stream = parsed.streams?.[0];
  const durationSec = parsed.format?.duration ? Number(parsed.format.duration) : null;
  // Coded width/height ignore the display-matrix rotation phones record for
  // portrait video; playback (and our ffmpeg poster extraction) auto-rotates,
  // so report the *displayed* orientation — swap on 90°/270°.
  const rotation = stream?.side_data_list?.find((d) => typeof d.rotation === 'number')?.rotation ?? 0;
  const sideways = Math.abs(rotation) % 180 === 90;
  return {
    durationMs: durationSec !== null && Number.isFinite(durationSec) ? Math.round(durationSec * 1000) : null,
    width: (sideways ? stream?.height : stream?.width) ?? null,
    height: (sideways ? stream?.width : stream?.height) ?? null,
  };
}
