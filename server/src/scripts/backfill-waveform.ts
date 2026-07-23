/**
 * One-off backfill: compute stored waveform peaks for voice messages
 * processed before the `media.waveform` column existed (migration 0007,
 * docs/VOICE_WAVEFORM.md).
 *
 * For each ready voice row with `waveform IS NULL`, downloads the transcoded
 * m4a from R2, decodes it to raw mono PCM with ffmpeg (same pass the
 * processing worker now runs), buckets it into 44 RMS peaks, and writes the
 * column. Voice notes are small (≤20MB ceiling, typically well under 1MB) —
 * this is cheap even over many rows.
 *
 * Peaks are computed in dry-run mode too (so the printed values are the real
 * ones), but nothing is written without --apply.
 *
 * Run inside the api container (compiled to dist/ by the normal build). On
 * the prod host add `--env-file /opt/apps/den/secrets/.env` like every other
 * compose invocation there:
 *   docker compose -f deploy/docker-compose.yml exec api \
 *     node server/dist/scripts/backfill-waveform.js            # dry run (default)
 *   docker compose -f deploy/docker-compose.yml exec api \
 *     node server/dist/scripts/backfill-waveform.js --apply    # write changes
 */
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { and, eq, isNull } from 'drizzle-orm';
import { closeDb, db } from '../db/index.js';
import { media } from '../db/schema.js';
import { runFfmpeg } from '../media/ffmpeg.js';
import { getObjectBuffer } from '../media/r2.js';
import { pcmToPeaks } from '../media/waveform.js';

const apply = process.argv.includes('--apply');

async function main(): Promise<void> {
  const rows = await db
    .select({ id: media.id, r2Key: media.r2Key, durationMs: media.durationMs })
    .from(media)
    .where(and(eq(media.kind, 'voice'), eq(media.status, 'ready'), isNull(media.waveform)));

  let done = 0;
  let failed = 0;

  const dir = await mkdtemp(join(tmpdir(), 'den-backfill-wave-'));
  try {
    for (const row of rows) {
      let waveform: number[];
      try {
        const inPath = join(dir, `${row.id}.m4a`);
        const pcmPath = join(dir, `${row.id}.pcm`);
        await writeFile(inPath, await getObjectBuffer(row.r2Key));
        // Same decode the processing worker runs: mono 8kHz raw s16le.
        await runFfmpeg(['-y', '-i', inPath, '-ac', '1', '-ar', '8000', '-f', 's16le', pcmPath]);
        waveform = pcmToPeaks(await readFile(pcmPath));
      } catch (err) {
        failed++;
        console.log(`fail  media ${row.id}: ${(err as Error).message}`);
        continue;
      }

      done++;
      const secs = row.durationMs != null ? `${(row.durationMs / 1000).toFixed(1)}s` : '?s';
      console.log(`${apply ? 'set ' : 'would set'} media ${row.id} (${secs}): ${waveform.length} peaks`);
      if (apply) await db.update(media).set({ waveform }).where(eq(media.id, row.id));
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }

  console.log(
    `\n${rows.length} voice rows without waveform: ${done} ${apply ? 'backfilled' : 'computed (dry run — rerun with --apply)'}, ${failed} failed`,
  );
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => void closeDb());
