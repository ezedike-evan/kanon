import { describe, expect, it } from 'vitest';
import {
  buildRestCanonical,
  buildWsSignInCanonical,
  createEd25519Signer,
  fromHex,
  generateEd25519KeyPair,
  normalizeEd25519Secret,
  sha256Hex,
  toBase64Url,
  toHex,
  verifyEd25519Base64Url,
} from './perpl-auth';

const EMPTY_SHA256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

describe('Perpl request signing', () => {
  it('hashes an empty body to the well-known sha256', async () => {
    expect(await sha256Hex('')).toBe(EMPTY_SHA256);
  });

  it('builds the six-field REST canonical string exactly as documented', () => {
    const canonical = buildRestCanonical({
      chainId: 143,
      method: 'get',
      target: '/v1/trading/fills?count=1',
      timestamp: '1760000000000',
      nonce: 'bm9uY2U',
      bodyHashHex: EMPTY_SHA256,
    });
    expect(canonical).toBe(
      ['143', 'GET', '/v1/trading/fills?count=1', '1760000000000', 'bm9uY2U', EMPTY_SHA256].join('\n'),
    );
    expect(canonical.split('\n')).toHaveLength(6);
  });

  it('refuses a target that includes the /api prefix', () => {
    expect(() =>
      buildRestCanonical({
        chainId: 143,
        method: 'GET',
        target: '/api/v1/trading/fills',
        timestamp: '1',
        nonce: 'n',
        bodyHashHex: EMPTY_SHA256,
      }),
    ).toThrow(/must not include the "\/api" prefix/);
  });

  it('builds the four-field WebSocket sign-in canonical string', () => {
    expect(buildWsSignInCanonical({ chainId: 10143, timestamp: '1760000000000', nonce: 'abc' })).toBe(
      '10143\ntrading-ws-signin\n1760000000000\nabc',
    );
  });

  it('produces an Ed25519 signature that verifies against the public key', async () => {
    const kp = await generateEd25519KeyPair();
    const sign = createEd25519Signer(kp.secretKeyHex);
    const canonical = buildWsSignInCanonical({ chainId: 143, timestamp: '1', nonce: 'n' });
    const sig = await sign(canonical);
    expect(sig).toMatch(/^[A-Za-z0-9_-]+$/); // base64url, no padding, no '+' '/' '='
    expect(await verifyEd25519Base64Url(kp.publicKeyHex, sig, canonical)).toBe(true);
    expect(await verifyEd25519Base64Url(kp.publicKeyHex, sig, canonical + 'x')).toBe(false);
  });

  it('rejects a secret that is not 32 bytes', () => {
    expect(() => createEd25519Signer('abcd')).toThrow(/32 bytes/);
  });

  it('reads a secret as hex, base64url or PEM, and as a seed with its public key', async () => {
    const kp = await generateEd25519KeyPair();
    const seed = fromHex(kp.secretKeyHex);
    const pub = fromHex(kp.publicKeyHex);
    const pair = new Uint8Array([...seed, ...pub]);
    const pkcs8 = new Uint8Array([...fromHex('302e020100300506032b657004220420'), ...seed]);
    const base64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));
    const pem = `-----BEGIN PRIVATE KEY-----\n${base64(pkcs8)}\n-----END PRIVATE KEY-----\n`;

    for (const form of [
      kp.secretKeyHex,
      `0x${kp.secretKeyHex.toUpperCase()}`,
      ` "${kp.secretKeyHex}" `,
      toBase64Url(seed),
      base64(seed),
      toHex(pair),
      toBase64Url(pair),
      toHex(pkcs8),
      base64(pkcs8),
      pem,
      pem.replace(/\n/g, '\\n'),
    ]) {
      expect(await normalizeEd25519Secret(form)).toBe(kp.secretKeyHex);
    }
  });

  it('refuses a secret it cannot read, without repeating it', async () => {
    const kp = await generateEd25519KeyPair();
    const other = await generateEd25519KeyPair();
    const mismatched = `${kp.secretKeyHex}${other.publicKeyHex.slice(2)}`;
    await expect(normalizeEd25519Secret(mismatched)).rejects.toThrow(/not a seed followed by its public key/);
    await expect(normalizeEd25519Secret(kp.secretKeyHex.slice(2))).rejects.toThrow(/unexpected length/);
    await expect(normalizeEd25519Secret('not a key!')).rejects.toThrow(/not hex, base64url or PEM/);
    await expect(normalizeEd25519Secret('')).rejects.toThrow(/not hex, base64url or PEM/);
    for (const bad of [mismatched, kp.secretKeyHex.slice(2)]) {
      const message = await normalizeEd25519Secret(bad).then(
        () => '',
        (e: Error) => e.message,
      );
      expect(message).not.toContain(bad.slice(0, 12));
    }
  });
});
