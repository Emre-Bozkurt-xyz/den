/**
 * End-to-end passkey check (docs/PASSKEYS.md §11).
 *
 * There is no browser here, so this drives the real HTTP ceremonies with a
 * **software authenticator** implemented below: a P-256 keypair plus correctly
 * built `authenticatorData`, a `none`-format attestation object, and real
 * signatures. That matters — a probe that mocked the crypto would pass while
 * the actual verification path was broken, which is the only part worth
 * testing.
 *
 * ⚠️ Dev stack only. It registers credentials against a real account.
 *
 *   npx tsx server/src/scripts/probe-passkey.ts http://localhost:3000
 */
import { createHash, createSign, generateKeyPairSync, randomBytes } from 'node:crypto';
import { isoBase64URL, isoCBOR } from '@simplewebauthn/server/helpers';

/** The CBOR value type the encoder accepts — mirrored rather than imported,
 *  since tiny-cbor is a transitive dep and not ours to depend on directly. */
type CBOR = number | bigint | string | Uint8Array | boolean | null | undefined | CBOR[] | Map<string | number, CBOR>;

const base = (process.argv[2] ?? 'http://localhost:3000').replace(/\/+$/, '');
const ORIGIN = base;

let failures = 0;
function check(label: string, ok: boolean, detail = ''): void {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`);
  if (!ok) failures++;
}

// ─── tiny cookie-jar HTTP client ────────────────────────────────────────────

class Session {
  private cookies = new Map<string, string>();

  /**
   * `any` for the parsed body, deliberately (CLAUDE.md: justify every one).
   * This is a probe that pokes at arbitrary success and error shapes across a
   * dozen endpoints; typing each would mean importing every DTO and would make
   * a *failing* response — the interesting case — the awkward one to inspect.
   * Nothing here ships to a client.
   */
  async call(
    path: string,
    init: { method?: string; body?: unknown } = {},
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ): Promise<{ status: number; body: any; code: string | null }> {
    // ⚠️ Only declare JSON when there IS a body. Fastify rejects a bodyless
    // request that claims `content-type: application/json` with a 400 before
    // the handler ever runs — which looked exactly like a broken DELETE route
    // the first time this probe ran. `lib/api.ts` sets the header the same
    // conditional way, so this now matches what the real client does.
    const headers: Record<string, string> = {};
    if (init.body !== undefined) headers['content-type'] = 'application/json';
    if (this.cookies.size > 0) {
      headers.cookie = [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ');
    }
    const res = await fetch(`${base}${path}`, {
      method: init.method ?? (init.body ? 'POST' : 'GET'),
      headers,
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    });
    for (const raw of res.headers.getSetCookie?.() ?? []) {
      const [pair] = raw.split(';');
      const idx = pair!.indexOf('=');
      const name = pair!.slice(0, idx);
      const value = pair!.slice(idx + 1);
      if (value === '' || /expires=thu, 01 jan 1970/i.test(raw)) this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
    const text = await res.text();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- see the doc comment on call()
    let body: any = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = text;
    }
    return { status: res.status, body, code: body?.error?.code ?? null };
  }
}

// ─── software authenticator ─────────────────────────────────────────────────

const b64u = (b: Buffer | Uint8Array): string => isoBase64URL.fromBuffer(new Uint8Array(b));

/** Build the COSE_Key (EC2/P-256/ES256) form of a raw uncompressed public key. */
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

class Authenticator {
  readonly credentialId = randomBytes(32);
  private privateKey: string;
  private publicRaw: Buffer;
  /** Reported sign counter. 0 means "this authenticator doesn't count", which
   *  is what Apple and Google actually do — the server must tolerate it. */
  signCount: number;

  constructor(signCount = 0) {
    const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    this.privateKey = privateKey.export({ type: 'pkcs8', format: 'pem' }) as string;
    this.publicRaw = Buffer.from(publicKey.export({ type: 'spki', format: 'der' })).subarray(-65);
    this.signCount = signCount;
  }

  private clientData(type: string, challenge: string): Buffer {
    return Buffer.from(JSON.stringify({ type, challenge, origin: ORIGIN, crossOrigin: false }));
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
    // UP | UV | AT
    const data = authData(rpId, 0x01 | 0x04 | 0x40, this.signCount, attested);
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
    const signed = Buffer.concat([
      data,
      createHash('sha256').update(clientDataJSON).digest(),
    ]);
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

// ─── the run ────────────────────────────────────────────────────────────────

const rnd = () => randomBytes(5).toString('hex');

async function main(): Promise<void> {
  console.log(`\nProbing ${base}\n`);
  const health = await fetch(`${base}/health`).catch(() => null);
  if (!health?.ok) {
    console.error(`✗ ${base}/health did not answer OK — is the stack up?`);
    process.exitCode = 1;
    return;
  }

  // Two throwaway accounts. Invite codes come from the CLI, so this expects
  // them passed in via env for a scripted run; otherwise it self-registers
  // using codes minted by the caller.
  const codes = (process.env.PROBE_INVITES ?? '').split(',').filter(Boolean);
  if (codes.length < 2) {
    console.error('✗ set PROBE_INVITES=<code1>,<code2> (mint with: npx tsx server/src/scripts/invite.ts create 2)');
    process.exitCode = 1;
    return;
  }

  const alice = new Session();
  const bob = new Session();
  const aliceName = `pk-alice-${rnd()}`;
  const bobName = `pk-bob-${rnd()}`;
  const password = 'probe-password-1234';

  for (const [s, name, code] of [
    [alice, aliceName, codes[0]!],
    [bob, bobName, codes[1]!],
  ] as const) {
    const r = await s.call('/api/auth/register', {
      body: { username: name, password, displayName: name, inviteCode: code },
    });
    if (r.status !== 201) {
      console.error(`✗ could not register ${name}: ${r.status} ${r.code}`);
      process.exitCode = 1;
      return;
    }
  }
  console.log(`registered ${aliceName} and ${bobName}\n`);

  const rpId = new URL(base).hostname;

  // ── 1. registration ─────────────────────────────────────────────────────
  console.log('1. register a passkey');
  const auth = new Authenticator();
  const regOpts = await alice.call('/api/auth/passkey/register/options', { body: {} });
  check('options issued', regOpts.status === 200 && !!regOpts.body?.challenge, String(regOpts.status));
  const regVerify = await alice.call('/api/auth/passkey/register/verify', {
    body: { response: auth.register(rpId, regOpts.body.challenge), label: 'Probe device' },
  });
  check('registration verified', regVerify.status === 201, `${regVerify.status} ${regVerify.code ?? ''}`);

  const list = await alice.call('/api/auth/passkey/credentials');
  check('credential listed with its label', list.body?.credentials?.[0]?.label === 'Probe device');

  // ── 2. login ────────────────────────────────────────────────────────────
  console.log('\n2. sign in with it');
  const fresh = new Session();
  const loginOpts = await fresh.call('/api/auth/passkey/login/options', { body: {} });
  check('login options issued', loginOpts.status === 200 && !!loginOpts.body?.challenge);
  const loginVerify = await fresh.call('/api/auth/passkey/login/verify', {
    body: { response: auth.authenticate(rpId, loginOpts.body.challenge) },
  });
  check('assertion accepted', loginVerify.status === 200, `${loginVerify.status} ${loginVerify.code ?? ''}`);
  check('session belongs to the right user', loginVerify.body?.username === aliceName, String(loginVerify.body?.username));

  // ── 3. a tampered assertion ─────────────────────────────────────────────
  console.log('\n3. reject a tampered assertion');
  const s3 = new Session();
  const o3 = await s3.call('/api/auth/passkey/login/options', { body: {} });
  // `any` so the signature field can be reached and corrupted — the whole
  // point of this case is producing a response the typed shape forbids.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const tampered = auth.authenticate(rpId, o3.body.challenge) as any;
  // Flip a byte of the signature.
  const sigBytes = Buffer.from(isoBase64URL.toBuffer(tampered.response.signature));
  sigBytes[sigBytes.length - 1] = (sigBytes[sigBytes.length - 1] ?? 0) ^ 0xff;
  tampered.response.signature = b64u(sigBytes);
  const bad = await s3.call('/api/auth/passkey/login/verify', { body: { response: tampered } });
  check('bad signature refused', bad.status === 400 && bad.code === 'passkey_failed', `${bad.status} ${bad.code}`);

  // ── 4. a replayed / stale challenge ─────────────────────────────────────
  console.log('\n4. reject a reused challenge');
  const s4 = new Session();
  const o4 = await s4.call('/api/auth/passkey/login/options', { body: {} });
  const first = await s4.call('/api/auth/passkey/login/verify', {
    body: { response: auth.authenticate(rpId, o4.body.challenge) },
  });
  const replay = await s4.call('/api/auth/passkey/login/verify', {
    body: { response: auth.authenticate(rpId, o4.body.challenge) },
  });
  check('first use accepted', first.status === 200, String(first.status));
  check('replay of the same challenge refused', replay.status === 400, `${replay.status} ${replay.code}`);

  // ── 5. cross-account ────────────────────────────────────────────────────
  // Alice's credential must never authenticate as Bob, and Bob must not be
  // able to rename or delete it.
  console.log("\n5. another user cannot touch Alice's credential");
  const credId: string = list.body?.credentials?.[0]?.id ?? '';
  if (!credId) {
    console.error('✗ no credential id to work with — the registration checks above must pass first.');
    process.exitCode = 1;
    return;
  }
  const bobRename = await bob.call(`/api/auth/passkey/credentials/${encodeURIComponent(credId)}`, {
    method: 'PATCH',
    body: { label: 'stolen' },
  });
  check("rename by another user is 404", bobRename.status === 404, `${bobRename.status} ${bobRename.code}`);
  const bobDelete = await bob.call(`/api/auth/passkey/credentials/${encodeURIComponent(credId)}`, {
    method: 'DELETE',
  });
  check('delete by another user is 404', bobDelete.status === 404, `${bobDelete.status} ${bobDelete.code}`);
  const bobList = await bob.call('/api/auth/passkey/credentials');
  check("another user's list does not include it", (bobList.body?.credentials ?? []).length === 0);

  // ── 6. the throttle interaction (docs/PASSKEYS.md §7) ───────────────────
  // THE check this feature must not ship without: lock the account by
  // password, then confirm a passkey still gets in and clears the counter.
  console.log('\n6. a password lock must NOT block passkey login');
  for (let i = 0; i < 12; i++) {
    const r = await new Session().call('/api/auth/login', {
      body: { username: aliceName, password: 'wrong-password-here' },
    });
    if (r.status === 423) break;
  }
  const lockedPw = await new Session().call('/api/auth/login', {
    body: { username: aliceName, password },
  });
  check('password login IS locked (precondition)', lockedPw.status === 423, `${lockedPw.status} ${lockedPw.code}`);

  const s6 = new Session();
  const o6 = await s6.call('/api/auth/passkey/login/options', { body: {} });
  const pkDuringLock = await s6.call('/api/auth/passkey/login/verify', {
    body: { response: auth.authenticate(rpId, o6.body.challenge) },
  });
  check('passkey login still succeeds while locked', pkDuringLock.status === 200, `${pkDuringLock.status} ${pkDuringLock.code}`);

  const pwAfter = await new Session().call('/api/auth/login', {
    body: { username: aliceName, password },
  });
  check('passkey login cleared the failure counter', pwAfter.status === 200, `${pwAfter.status} ${pwAfter.code}`);

  // ── 7. the >=1-login-method rule ────────────────────────────────────────
  console.log('\n7. removal rules');
  const del = await alice.call(`/api/auth/passkey/credentials/${encodeURIComponent(credId)}`, {
    method: 'DELETE',
  });
  check('own credential can be removed (a password remains)', del.status === 200, `${del.status} ${del.code}`);
  const after = await alice.call('/api/auth/passkey/credentials');
  check('list is empty again', (after.body?.credentials ?? []).length === 0);

  // ── 8. sign-count regression ────────────────────────────────────────────
  // Platform authenticators (Apple, Google) report a permanent 0, and that
  // must be ACCEPTED — sections 1-7 already prove it, since `auth` reports 0
  // throughout. A counter that IS in use and goes backwards means a cloned
  // credential, and must not be.
  console.log('\n8. sign-count regression (a counting authenticator)');
  const counting = new Authenticator(5);
  const rOpts = await bob.call('/api/auth/passkey/register/options', { body: {} });
  const rVerify = await bob.call('/api/auth/passkey/register/verify', {
    body: { response: counting.register(rpId, rOpts.body.challenge), label: 'Counting key' },
  });
  check('counting authenticator registers', rVerify.status === 201, `${rVerify.status} ${rVerify.code ?? ''}`);

  const sGood = new Session();
  const oGood = await sGood.call('/api/auth/passkey/login/options', { body: {} });
  const good = await sGood.call('/api/auth/passkey/login/verify', {
    body: { response: counting.authenticate(rpId, oGood.body.challenge, 6) },
  });
  check('an advancing counter is accepted', good.status === 200, `${good.status} ${good.code ?? ''}`);

  const sStale = new Session();
  const oStale = await sStale.call('/api/auth/passkey/login/options', { body: {} });
  const stale = await sStale.call('/api/auth/passkey/login/verify', {
    body: { response: counting.authenticate(rpId, oStale.body.challenge, 4) },
  });
  check('a REGRESSED counter is refused', stale.status === 400 && stale.code === 'passkey_failed', `${stale.status} ${stale.code}`);

  const sSame = new Session();
  const oSame = await sSame.call('/api/auth/passkey/login/options', { body: {} });
  const same = await sSame.call('/api/auth/passkey/login/verify', {
    body: { response: counting.authenticate(rpId, oSame.body.challenge, 6) },
  });
  check('a REPEATED counter is refused', same.status === 400, `${same.status} ${same.code}`);

  console.log(`\n${failures === 0 ? '✓ all checks passed' : `✗ ${failures} check(s) failed`}\n`);
  if (failures > 0) process.exitCode = 1;
}

void main();
