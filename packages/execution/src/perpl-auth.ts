/**
 * Perpl request signing. Verified against
 * https://github.com/PerplFoundation/api-docs (authentication.md, README.md,
 * websocket.md) on 2026-09-20.
 *
 * Perpl has no bearer token and no session: an API key is an Ed25519 key
 * pair, the server stores only the public half, and every request is signed.
 *
 * REST canonical string, six fields joined by "\n":
 *
 *   chainId
 *   METHOD
 *   target            path + query exactly as sent, WITHOUT the "/api" prefix
 *                     (e.g. "/v1/trading/fills?count=1"; the docs' own
 *                     example sends to `${API_URL}${target}` where API_URL
 *                     already ends in "/api")
 *   timestampMs       must be within 30 s of server time
 *   nonce             base64url, single-use
 *   sha256(body) hex  of the empty string for a GET
 *
 * The signature is base64url (no padding) of Ed25519 over the UTF-8 bytes of
 * that string, sent with `X-API-Key`, `X-API-Timestamp`, `X-API-Nonce` and
 * `X-API-Signature`.
 *
 * WebSocket sign-in (`mt: 29`) signs four fields:
 * `chainId\ntrading-ws-signin\ntimestampMs\nnonce`.
 */

import * as ed from '@noble/ed25519';

export const PERPL_AUTH_HEADERS = {
  apiKey: 'X-API-Key',
  timestamp: 'X-API-Timestamp',
  nonce: 'X-API-Nonce',
  signature: 'X-API-Signature',
} as const;

/** Signs the canonical string and returns a base64url (no padding) signature. */
export type PerplSigner = (canonical: string) => Promise<string>;

export function toBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function toHex(bytes: Uint8Array): string {
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function fromHex(hex: string): Uint8Array {
  const clean = hex.replace(/^0x/, '');
  if (!/^([0-9a-fA-F]{2})*$/.test(clean)) throw new Error('not a hex string');
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export function randomNonce(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return toBase64Url(bytes);
}

export async function sha256Hex(body: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(body));
  return toHex(new Uint8Array(digest));
}

export function buildRestCanonical(parts: {
  chainId: number;
  method: string;
  target: string;
  timestamp: string;
  nonce: string;
  bodyHashHex: string;
}): string {
  if (parts.target.startsWith('/api/')) {
    // The single most likely integration mistake; fail loudly instead of
    // signing a string the server will reject with an opaque 401.
    throw new Error(`Perpl canonical target must not include the "/api" prefix, got "${parts.target}"`);
  }
  return [String(parts.chainId), parts.method.toUpperCase(), parts.target, parts.timestamp, parts.nonce, parts.bodyHashHex].join(
    '\n',
  );
}

export function buildWsSignInCanonical(parts: { chainId: number; timestamp: string; nonce: string }): string {
  return [String(parts.chainId), 'trading-ws-signin', parts.timestamp, parts.nonce].join('\n');
}

export interface PerplWsSignInFrame {
  mt: 29;
  chain_id: number;
  api_key: string;
  timestamp: string;
  nonce: string;
  signature: string;
}

/** Ed25519 signer over a 32-byte secret (hex, optional 0x). The secret never
 * leaves this closure and is never logged or attached to an error. */
export function createEd25519Signer(secretKeyHex: string): PerplSigner {
  const secret = fromHex(secretKeyHex);
  if (secret.length !== 32) throw new Error('Ed25519 secret key must be 32 bytes');
  return async (canonical) => toBase64Url(await ed.signAsync(new TextEncoder().encode(canonical), secret));
}

export interface Ed25519KeyPair {
  secretKeyHex: string;
  /** Raw 32-byte public key, 0x-hex, the form `/api-key/payload` expects. */
  publicKeyHex: string;
}

export async function generateEd25519KeyPair(): Promise<Ed25519KeyPair> {
  const secret = ed.utils.randomPrivateKey();
  const pub = await ed.getPublicKeyAsync(secret);
  return { secretKeyHex: toHex(secret), publicKeyHex: `0x${toHex(pub)}` };
}

export async function signHexWithEd25519(secretKeyHex: string, message: Uint8Array): Promise<string> {
  return `0x${toHex(await ed.signAsync(message, fromHex(secretKeyHex)))}`;
}

export async function verifyEd25519Base64Url(publicKeyHex: string, signatureB64Url: string, canonical: string): Promise<boolean> {
  const b64 = signatureB64Url.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4));
  const sig = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  return ed.verifyAsync(sig, new TextEncoder().encode(canonical), fromHex(publicKeyHex));
}
