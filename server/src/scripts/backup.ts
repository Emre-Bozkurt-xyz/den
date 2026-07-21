/**
 * Database backup uploader (BACKBONE §14 Stage 6 "backups running").
 *
 * Reads a `pg_dump -Fc` stream on **stdin** and stores it in R2 under
 * `backups/`, then prunes so at most BACKUP_KEEP dumps ever exist. Run inside
 * the `api` container by deploy/backup.sh — that container already has the R2
 * credentials and the AWS SDK, so backups need no extra tooling on the host
 * and no second copy of the keys anywhere.
 *
 * Usage (normally via deploy/backup.sh, not by hand):
 *   ... | node server/dist/scripts/backup.js upload
 *   node server/dist/scripts/backup.js list
 *   node server/dist/scripts/backup.js prune
 *
 * ⚠️ A dump contains EVERYTHING: message bodies, argon2 password hashes,
 * session rows, invite codes. It lives in the same private bucket as media,
 * so one leaked R2 credential exposes both. Acceptable for a closed circle;
 * revisit (separate bucket + its own scoped token) if that stops being true.
 *
 * ⚠️ The `backups/` prefix is deliberately outside `media/` (§7 key scheme).
 * If the §7 orphan-sweep job is ever built — "delete R2 objects whose media
 * row is missing" — it MUST scope itself to `media/` or it will happily
 * delete every backup.
 */
import { DeleteObjectsCommand, ListObjectsV2Command } from '@aws-sdk/client-s3';
import { env } from '../env.js';
import { s3, putObjectBuffer } from '../media/r2.js';

const PREFIX = 'backups/';

/** How many dumps to retain. Deliberately small and bounded — an unclamped
 *  backup count silently eats R2 storage forever for files nobody reads. */
function keepCount(): number {
  const raw = Number(process.env.BACKUP_KEEP ?? '7');
  if (!Number.isFinite(raw) || raw < 1) return 7;
  return Math.floor(raw);
}

interface StoredBackup {
  key: string;
  size: number;
  lastModified: Date | undefined;
}

/** Every object under `backups/`, newest first. Paginates — correctness is
 *  cheap here and a truncated list would make pruning delete the wrong ones. */
async function listBackups(): Promise<StoredBackup[]> {
  const out: StoredBackup[] = [];
  let token: string | undefined;
  do {
    const res = await s3.send(
      new ListObjectsV2Command({ Bucket: env.r2Bucket, Prefix: PREFIX, ContinuationToken: token }),
    );
    for (const o of res.Contents ?? []) {
      if (o.Key) out.push({ key: o.Key, size: o.Size ?? 0, lastModified: o.LastModified });
    }
    token = res.IsTruncated ? res.NextContinuationToken : undefined;
  } while (token);

  // Sort by key, not LastModified: the key embeds a UTC ISO-ish timestamp, so
  // it sorts lexicographically in true chronological order and doesn't depend
  // on clock skew or on R2 preserving mtimes.
  return out.sort((a, b) => (a.key < b.key ? 1 : a.key > b.key ? -1 : 0));
}

async function readStdin(): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

function fmtSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
}

async function prune(): Promise<void> {
  const keep = keepCount();
  const all = await listBackups();
  const doomed = all.slice(keep);
  if (doomed.length === 0) {
    console.log(`prune: ${all.length} backup(s) stored, keeping ${keep} — nothing to remove`);
    return;
  }
  // One batched delete rather than N round trips.
  await s3.send(
    new DeleteObjectsCommand({
      Bucket: env.r2Bucket,
      Delete: { Objects: doomed.map((d) => ({ Key: d.key })) },
    }),
  );
  console.log(`prune: removed ${doomed.length} old backup(s), ${keep} retained`);
  for (const d of doomed) console.log(`  - ${d.key}`);
}

async function upload(): Promise<void> {
  const body = await readStdin();
  // A truncated or empty dump is worse than no dump: it looks like a backup
  // exists while restoring nothing. deploy/backup.sh also validates the file
  // with `pg_restore --list` before it ever gets here; this is the last line.
  if (body.length < 1024) {
    throw new Error(`refusing to upload a ${body.length}-byte dump — almost certainly a failed pg_dump`);
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const key = `${PREFIX}den-${stamp}.dump`;
  await putObjectBuffer(key, body, 'application/octet-stream');
  console.log(`uploaded ${key} (${fmtSize(body.length)})`);
  await prune();
}

async function list(): Promise<void> {
  const all = await listBackups();
  if (all.length === 0) {
    console.log('No backups stored yet.');
    return;
  }
  console.log(`${all.length} backup(s), newest first (retaining ${keepCount()}):`);
  for (const b of all) {
    console.log(`  ${b.key}  ${fmtSize(b.size).padStart(10)}  ${b.lastModified?.toISOString() ?? ''}`);
  }
}

async function main(): Promise<void> {
  const cmd = process.argv[2];
  if (cmd === 'upload') await upload();
  else if (cmd === 'list') await list();
  else if (cmd === 'prune') await prune();
  else {
    console.log('Usage: backup <upload | list | prune>   (upload reads a pg_dump -Fc stream on stdin)');
    process.exitCode = 1;
  }
}

main().catch((e: unknown) => {
  console.error('backup failed:', e instanceof Error ? e.message : e);
  process.exit(1);
});
