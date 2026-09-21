import { describe, expect, it } from 'vitest';
import {
  buildRestCanonical,
  buildWsSignInCanonical,
  createEd25519Signer,
  generateEd25519KeyPair,
  sha256Hex,
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
});
