/**
 * Voice-record PoC (Stage 0 GO/NO-GO gate — BACKBONE §14, §7).
 *
 * Purpose: prove the cursed voice path works cross-platform:
 *   MediaRecorder (audio/mp4 on iOS Safari, audio/webm;opus on Chrome)
 *     → upload → ffmpeg → ONE format (AAC in .m4a) → plays on iOS + Android + desktop.
 *
 * Throwaway PoC. Notes on why it looks different from the real app:
 *   - The real media path NEVER routes bytes through the API server (hard
 *     invariant 2): client ⇄ R2 via presigned URLs. Here we accept a direct
 *     upload purely to exercise the ffmpeg transcode + playback locally. The
 *     Stage 3 pipeline replaces this entirely.
 *   - Output is written to a temp dir and served back; nothing is persisted.
 */
import { mkdir, rm, stat } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { validation } from '../errors.js';
import { runFfmpeg } from '../media/ffmpeg.js';

const WORK_DIR = join(process.cwd(), 'server', 'tmp', 'voice-poc');

export async function voicePocRoutes(app: FastifyInstance): Promise<void> {
  await mkdir(WORK_DIR, { recursive: true });

  app.post('/voice-poc/upload', async (req) => {
    const file = await req.file();
    if (!file) throw validation('No audio file in request');

    const id = randomUUID();
    const inPath = join(WORK_DIR, `${id}.in`);
    const outPath = join(WORK_DIR, `${id}.m4a`);

    // Persist the uploaded blob to a temp file.
    const { pipeline } = await import('node:stream/promises');
    const { createWriteStream } = await import('node:fs');
    await pipeline(file.file, createWriteStream(inPath));
    if (file.file.truncated) {
      await rm(inPath, { force: true });
      throw validation('Recording too large for PoC');
    }

    // Normalize whatever MediaRecorder produced → AAC/m4a, mono, 48k, sensible bitrate.
    try {
      await runFfmpeg([
        '-y',
        '-i', inPath,
        '-vn',
        '-ac', '1',
        // Normalize the sample rate — MediaRecorder can emit odd rates, and low
        // rates blow AAC's per-frame bit budget at 96k ("too many bits per frame").
        '-ar', '48000',
        '-c:a', 'aac', '-b:a', '96k',
        // `-strict experimental` keeps older ffmpeg builds (native AAC) happy;
        // harmless on modern ffmpeg where AAC is stable.
        '-strict', 'experimental',
        '-movflags', '+faststart',
        outPath,
      ]);
    } catch (e) {
      await rm(inPath, { force: true });
      req.log.error({ err: e }, 'voice PoC: transcode failed');
      throw validation('Transcode failed — is ffmpeg on PATH?');
    }
    await rm(inPath, { force: true });

    const { size } = await stat(outPath);
    req.log.info({ id, size }, 'voice PoC: transcoded to m4a');
    return { id, mime: 'audio/mp4', sizeBytes: size };
  });

  app.get<{ Params: { id: string } }>('/voice-poc/:id', async (req, reply) => {
    const { id } = req.params;
    if (!/^[0-9a-f-]{36}$/.test(id)) throw validation('Bad id');
    const path = join(WORK_DIR, `${id}.m4a`);
    try {
      await stat(path);
    } catch {
      return reply.status(404).send({ error: { code: 'not_found', message: 'Clip gone' } });
    }
    // audio/mp4 is the m4a MIME that plays natively everywhere.
    reply.header('Content-Type', 'audio/mp4');
    reply.header('Accept-Ranges', 'bytes');
    return reply.send(createReadStream(path));
  });
}

export const VOICE_POC_WORK_DIR = WORK_DIR;
