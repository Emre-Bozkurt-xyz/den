/**
 * One-off backfill: fix media rows whose stored width/height don't match the
 * displayed orientation.
 *
 * Rows processed before the 2026-07-22 orientation fixes (process.ts /
 * ffmpeg.ts) recorded pre-rotation dimensions: EXIF orientations 5–8 for
 * photos, display-matrix rotation for portrait videos — both leave
 * width/height swapped relative to what's actually displayed. The client's
 * `PreviewImage` layout reservation is built from these dims, so wrong rows
 * still cause the "chat opens above the bottom" scroll deficit.
 *
 * The stored pixels are ground truth: thumb.webp (images) and poster.jpg
 * (videos) are both orientation-normalized on write, so probing them with
 * sharp gives the displayed orientation directly. Thumbs/posters are small —
 * this never downloads original media bytes.
 *
 *   images  — thumb is ratio-preserving but scaled: swap stored w/h when the
 *             thumb's aspect ratio matches the inverse better than the stored
 *             ratio (magnitudes stay untouched).
 *   videos  — poster is the exact displayed frame: overwrite w/h outright.
 *   voice / no-thumb / null-dims rows — skipped (nothing to fix or no cheap
 *             ground truth; reported in the summary).
 *
 * Run inside the api container (compiled to dist/ by the normal build). On
 * the prod host add `--env-file /opt/apps/den/secrets/.env` like every other
 * compose invocation there (deploy/README.md):
 *   docker compose -f deploy/docker-compose.yml exec api \
 *     node server/dist/scripts/backfill-dims.js            # dry run (default)
 *   docker compose -f deploy/docker-compose.yml exec api \
 *     node server/dist/scripts/backfill-dims.js --apply    # write changes
 */
import { and, eq, inArray, isNotNull } from 'drizzle-orm';
import sharp from 'sharp';
import { closeDb, db } from '../db/index.js';
import { media } from '../db/schema.js';
import { getObjectBuffer } from '../media/r2.js';

const apply = process.argv.includes('--apply');

async function main(): Promise<void> {
  const rows = await db
    .select({
      id: media.id,
      kind: media.kind,
      width: media.width,
      height: media.height,
      thumbKey: media.thumbKey,
    })
    .from(media)
    .where(and(inArray(media.kind, ['image', 'video']), eq(media.status, 'ready'), isNotNull(media.thumbKey)));

  let fixed = 0;
  let ok = 0;
  let skipped = 0;

  for (const row of rows) {
    if (!row.width || !row.height || !row.thumbKey) {
      skipped++;
      console.log(`skip  media ${row.id} (${row.kind}): missing dims or thumb`);
      continue;
    }

    let probe: { width?: number; height?: number };
    try {
      probe = await sharp(await getObjectBuffer(row.thumbKey)).metadata();
    } catch (err) {
      skipped++;
      console.log(`skip  media ${row.id} (${row.kind}): probe failed — ${(err as Error).message}`);
      continue;
    }
    if (!probe.width || !probe.height) {
      skipped++;
      console.log(`skip  media ${row.id} (${row.kind}): probe returned no dimensions`);
      continue;
    }

    let next: { width: number; height: number } | null = null;
    if (row.kind === 'video') {
      // Poster = the displayed frame, exactly.
      if (probe.width !== row.width || probe.height !== row.height) {
        next = { width: probe.width, height: probe.height };
      }
    } else {
      // Thumb is scaled but ratio-preserving — swap iff the inverted stored
      // ratio matches the thumb better than the stored ratio does (log-space
      // so the comparison is symmetric; exact for anything non-square).
      const stored = Math.abs(Math.log((row.width / row.height) * (probe.height / probe.width)));
      const swapped = Math.abs(Math.log((row.height / row.width) * (probe.height / probe.width)));
      if (swapped < stored) next = { width: row.height, height: row.width };
    }

    if (!next) {
      ok++;
      continue;
    }

    fixed++;
    console.log(
      `${apply ? 'fix ' : 'would fix'} media ${row.id} (${row.kind}): ${row.width}×${row.height} → ${next.width}×${next.height}`,
    );
    if (apply) await db.update(media).set(next).where(eq(media.id, row.id));
  }

  console.log(
    `\n${rows.length} rows scanned: ${ok} already correct, ${fixed} ${apply ? 'fixed' : 'need fixing (dry run — rerun with --apply)'}, ${skipped} skipped`,
  );
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => void closeDb());
