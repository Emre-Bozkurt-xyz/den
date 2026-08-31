/**
 * A software WebAuthn authenticator, for probes.
 *
 * Real P-256 keypair, correctly assembled `authenticatorData`, a `none`-format
 * attestation object and real ES256 signatures — so a probe using it exercises
 * the actual verification path rather than a mock of it. Mocking the crypto
 * would leave the only part that can be silently wrong untested.
 *
 * ⚠️ Shared by every probe that needs a credential (passkey, sign-in freeze,
 * …). One implementation on purpose: two would drift, and a drift here surfaces
 * as "passkeys stopped working" rather than as a failing test.
 */
import { createHash, createSign, generateKeyPairSync, randomBytes } from 'node:crypto';
import { isoBase64URL, isoCBOR } from '@simplewebauthn/server/helpers';

/** The CBOR value type the encoder accepts — mirrored rather than imported,
 *  since tiny-cbor is a transitive dep and not ours to depend on directly. */
export type CBOR =
  | number
  | bigint
  | string
  | Uint8Array
  | boolean
  | null
  | undefined
  | CBOR[]
  | Map<string | number, CBOR>;

export const b64u = (b: Buffer | Uint8Array): string => isoBase64URL.fromBuffer(new Uint8Array(b));

/** COSE_Key (EC2/P-256/ES256) form of a raw uncompressed public key. */
function coseKey(raw: Buffer): Uint8Array {
  const x = raw.subarray(1, 33);
  const y = raw.subarray(33, 65);
  const m = new Map<string | number, CBOR>([
    [1, 2], // kty: EC2
    [3, -7], // alg: ES256
    [-1, 1], // crv: P-256
    [-2, new Uint8Array(x)],
    [-3, new Uint8Array(y)],
  ]);
  return new Uint8Array(isoCBOR.encode(m));
}

/** `authenticatorData`: rpIdHash | flags | signCount | [attestedCredentialData] */
function authData(rpId: string, flags: number, signCount: number, attested?: Buffer): Buffer {
  const rpIdHash = createHash('sha256').update(rpId).digest();
  const counter = Buffer.alloc(4);
  counter.writeUInt32BE(signCount);
  return Buffer.concat([rpIdHash, Buffer.from([flags]), counter, attested ?? Buffer.alloc(0)]);
}

export class Authenticator {
  readonly credentialId = randomBytes(32);
  private privateKey: string;
  private publicRaw: Buffer;
  /** The origin the ceremony claims. Must match the server's expectedOrigins. */
  private origin: string;
  /** Reported sign counter. 0 means "this authenticator doesn't count", which
   *  is what Apple and Google actually do — the server must tolerate it. */
  signCount: number;

  constructor(origin: string, signCount = 0) {
    this.origin = origin;
    const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    this.privateKey = privateKey.export({ type: 'pkcs8', format: 'pem' }) as string;
    this.publicRaw = Buffer.from(publicKey.export({ type: 'spki', format: 'der' })).subarray(-65);
    this.signCount = signCount;
  }

  private clientData(type: string, challenge: string): Buffer {
    return Buffer.from(JSON.stringify({ type, challenge, origin: this.origin, crossOrigin: false }));
  }

  /** A registration response, `none` attestation. */
  register(rpId: string, challenge: string): Record<string, unknown> {
    const cose = coseKey(this.publicRaw);
    const attested = Buffer.concat([
      Buffer.alloc(16), // AAGUID: all zeroes
      Buffer.from([this.credentialId.length >> 8, this.credentialId.length & 0xff]),
      this.credentialId,
      Buffer.from(cose),
    ]);
    const data = authData(rpId, 0x01 | 0x04 | 0x40, this.signCount, attested); // UP | UV | AT
    const attestationObject = isoCBOR.encode(
      new Map<string | number, CBOR>([
        ['fmt', 'none'],
        ['attStmt', new Map<string | number, CBOR>()],
        ['authData', new Uint8Array(data)],
      ]),
    );
    const clientDataJSON = this.clientData('webauthn.create', challenge);
    return {
      id: b64u(this.credentialId),
      rawId: b64u(this.credentialId),
      type: 'public-key',
      clientExtensionResults: {},
      response: {
        clientDataJSON: b64u(clientDataJSON),
        attestationObject: b64u(new Uint8Array(attestationObject)),
        transports: ['internal'],
      },
    };
  }

  /** An assertion. `counterOverride` lets a test present a stale counter. */
  authenticate(rpId: string, challenge: string, counterOverride?: number): Record<string, unknown> {
    const count = counterOverride ?? (this.signCount === 0 ? 0 : ++this.signCount);
    const data = authData(rpId, 0x01 | 0x04, count); // UP | UV
    const clientDataJSON = this.clientData('webauthn.get', challenge);
    const signed = Buffer.concat([data, createHash('sha256').update(clientDataJSON).digest()]);
    const signature = createSign('SHA256').update(signed).sign(this.privateKey);
    return {
      id: b64u(this.credentialId),
      rawId: b64u(this.credentialId),
      type: 'public-key',
      clientExtensionResults: {},
      response: {
        clientDataJSON: b64u(clientDataJSON),
        authenticatorData: b64u(data),
        signature: b64u(signature),
        userHandle: null,
      },
    };
  }
}
