/**
 * R2 (S3-compatible) client — BACKBONE §3/§7. Media bytes never transit the
 * API server (CLAUDE.md hard invariant 2): this module only mints presigned
 * PUT/GET URLs and does small metadata calls (HEAD to verify an upload).
 *
 * Locally this points at the docker-compose MinIO service; prod points it at
 * the real Cloudflare R2 account endpoint (env.ts). Same client code either
 * way — R2's S3 API compatibility is the whole point.
 */
import { DeleteObjectCommand, HeadObjectCommand, GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { MediaLimits, type MediaKind } from '@den/shared';
import { env } from '../env.js';

/** Operational client — the actual network calls the server makes (HEAD, GET,
 *  PUT/DELETE for internal use) go through whatever endpoint this process can
 *  reach. In docker-compose that's the internal `minio` service hostname. */
export const s3 = new S3Client({
  region: env.r2Region,
  endpoint: env.r2Endpoint,
  forcePathStyle: env.r2ForcePathStyle,
  credentials: {
    accessKeyId: env.r2AccessKeyId,
    secretAccessKey: env.r2SecretAccessKey,
  },
});

/** Signing-only client, used exclusively for `getSignedUrl` — which never
 *  makes a network call, just computes a signature scoped to whatever
 *  endpoint the client is configured with. SigV4 signs the Host header, so a
 *  URL signed for one host and then fetched from a different host fails with
 *  SignatureDoesNotMatch — you can't sign against the internal endpoint and
 *  rewrite the host afterward. When `r2PublicEndpoint` differs from
 *  `r2Endpoint` (dev-only MinIO split: server reaches MinIO via the docker
 *  network, the browser via localhost), presigning must target the
 *  browser-reachable host directly instead. In prod both are the same public
 *  R2 host, so this client is configured identically to `s3`. */
const signingS3 = env.r2PublicEndpoint
  ? new S3Client({
      region: env.r2Region,
      endpoint: env.r2PublicEndpoint,
      forcePathStyle: env.r2ForcePathStyle,
      credentials: { accessKeyId: env.r2AccessKeyId, secretAccessKey: env.r2SecretAccessKey },
    })
  : s3;

/** R2 key scheme (§7 hygiene): chat-prefixed so a future per-chat export/
 *  deletion sweep is a prefix list, not a table scan. */
export function mediaKey(chatId: bigint, mediaId: bigint, filename: string): string {
  return `media/${chatId}/${mediaId}/${filename}`;
}

export async function presignPut(key: string, contentType: string): Promise<string> {
  const cmd = new PutObjectCommand({ Bucket: env.r2Bucket, Key: key, ContentType: contentType });
  return getSignedUrl(signingS3, cmd, { expiresIn: MediaLimits.putUrlTtlSeconds });
}

export async function presignGet(key: string): Promise<string> {
  const cmd = new GetObjectCommand({ Bucket: env.r2Bucket, Key: key });
  return getSignedUrl(signingS3, cmd, { expiresIn: MediaLimits.getUrlTtlSeconds });
}

export interface HeadResult {
  sizeBytes: number;
  contentType: string | undefined;
}

/** Verify an object actually landed after the client claims upload-complete
 *  (CLAUDE.md: "Never trust client-declared mime/size"). Throws if missing. */
export async function headObject(key: string): Promise<HeadResult> {
  const res = await s3.send(new HeadObjectCommand({ Bucket: env.r2Bucket, Key: key }));
  return { sizeBytes: res.ContentLength ?? 0, contentType: res.ContentType };
}

export async function getObjectBuffer(key: string): Promise<Buffer> {
  const res = await s3.send(new GetObjectCommand({ Bucket: env.r2Bucket, Key: key }));
  const bytes = await res.Body?.transformToByteArray();
  if (!bytes) throw new Error(`empty object body for key ${key}`);
  return Buffer.from(bytes);
}

/** First `bytes` of an object — enough for magic-number sniffing (file-type)
 *  without downloading a full 500MB video just to verify its header. */
export async function getObjectHead(key: string, bytes = 4100): Promise<Buffer> {
  const res = await s3.send(new GetObjectCommand({ Bucket: env.r2Bucket, Key: key, Range: `bytes=0-${bytes - 1}` }));
  const body = await res.Body?.transformToByteArray();
  if (!body) throw new Error(`empty object body for key ${key}`);
  return Buffer.from(body);
}

export async function putObjectBuffer(key: string, body: Buffer, contentType: string): Promise<void> {
  await s3.send(new PutObjectCommand({ Bucket: env.r2Bucket, Key: key, Body: body, ContentType: contentType }));
}

export async function deleteObject(key: string): Promise<void> {
  await s3.send(new DeleteObjectCommand({ Bucket: env.r2Bucket, Key: key }));
}

/** §6 upload validation ceiling, checked again here after the real HEAD. */
export function maxBytesFor(kind: MediaKind): number {
  return MediaLimits.maxBytes[kind];
}
