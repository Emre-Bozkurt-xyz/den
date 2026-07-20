/**
 * ffmpeg/ffprobe process wrappers, shared by the voice PoC (routes/voice-poc.ts)
 * and the real Stage 3 worker (media/process.ts). Both spawn the CLI rather
 * than a binding — ffmpeg's on PATH in the Docker image (Dockerfile.api) and
 * expected on PATH for local dev (BACKBONE §14 Stage 0 gate).
 */
import { spawn } from 'node:child_process';

export async function runFfmpeg(args: string[]): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const ff = spawn('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    ff.stderr.on('data', (d) => (stderr += d.toString()));
    ff.on('error', (e) => reject(new Error(`ffmpeg spawn failed: ${e.message}`)));
    ff.on('close', (code) =>
      code === 0 ? resolve() : reject(new Error(`ffmpeg exited ${code}: ${stderr.slice(-500)}`)),
    );
  });
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
      '-show_entries', 'stream=width,height',
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
    streams?: { width?: number; height?: number }[];
    format?: { duration?: string };
  };
  const stream = parsed.streams?.[0];
  const durationSec = parsed.format?.duration ? Number(parsed.format.duration) : null;
  return {
    durationMs: durationSec !== null && Number.isFinite(durationSec) ? Math.round(durationSec * 1000) : null,
    width: stream?.width ?? null,
    height: stream?.height ?? null,
  };
}
