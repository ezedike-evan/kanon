/**
 * Programmatic Perpl API-key enrollment, per
 * https://github.com/PerplFoundation/api-docs/blob/main/integrations.md
 * (verified 2026-09-20).
 *
 * The CONFIRM_BEFORE_LIVE gap this closes: the EIP-712 typed data for
 * `POST /api/v1/api-key/enroll` is NOT something a client hard-codes. The
 * server returns it from `POST /api/v1/api-key/payload` together with an
 * opaque `mac`, and the client signs it "exactly as returned". So the whole
 * flow is:
 *
 *   1. generate an Ed25519 key pair locally (the private key never leaves)
 *   2. POST /v1/api-key/payload  { chain_id, address, public_key, scope_mask, label, ... }
 *        -> { typed_data, mac }
 *   3. wallet signs typed_data (secp256k1 EIP-712), with `EIP712Domain`
 *      stripped from `types` because ethers takes the domain separately
 *   4. API key signs the EIP-712 digest keccak256(0x1901 || domainSeparator
 *      || hashStruct(message)) with Ed25519  ->  proof of possession
 *   5. POST /v1/api-key/enroll { chain_id, address, typed_data, mac,
 *        signature, pop_signature }  ->  { api_key: { api_key, ... } }
 *
 * The wallet signature is injected (`signTypedData`) because in the product
 * it comes from the user's embedded wallet, not from a key this package
 * holds. A private-key helper exists for scripts and tests only.
 *
 * Needs a live wallet and a Perpl-whitelisted `Origin`, so it is exercised
 * here only against a mocked HTTP layer (see perpl-enroll.test.ts). An enroll
 * response also does not create an exchange account: that is the separate
 * on-chain three-step safeguard documented in README.md.
 */

import { ethers } from 'ethers';
import { z } from 'zod';
import { PERPL_CHAIN_ID, PERPL_REST_BASE_URL, type PerplNetwork } from './perpl-constants';
import { fromHex, generateEd25519KeyPair, signHexWithEd25519, type Ed25519KeyPair } from './perpl-auth';

/** `scope_mask`: 1 = read, 2 = trade (implies read), 3 = both. Withdrawals
 * are never permitted through an API key, whatever the scope. */
export const PERPL_SCOPE = { read: 1, trade: 2, readTrade: 3 } as const;

const TypedDataSchema = z.looseObject({
  types: z.record(z.string(), z.array(z.object({ name: z.string(), type: z.string() }))),
  domain: z.record(z.string(), z.unknown()),
  message: z.record(z.string(), z.unknown()),
  primaryType: z.string().optional(),
});
export type PerplTypedData = z.infer<typeof TypedDataSchema>;

const PayloadResponseSchema = z.looseObject({ typed_data: TypedDataSchema, mac: z.string() });

const EnrollResponseSchema = z.looseObject({
  api_key: z.looseObject({
    api_key: z.string().min(1),
    address: z.string().optional(),
    scope_mask: z.number().optional(),
    label: z.string().optional(),
    origin: z.string().optional(),
    expires_at: z.number().optional(),
    created_at: z.number().optional(),
  }),
});
export type PerplApiKeyInfo = z.infer<typeof EnrollResponseSchema>['api_key'];

/** What the wallet signs. `types` already has `EIP712Domain` removed. */
export interface WalletTypedDataRequest {
  domain: Record<string, unknown>;
  types: Record<string, Array<{ name: string; type: string }>>;
  message: Record<string, unknown>;
}
export type WalletTypedDataSigner = (request: WalletTypedDataRequest) => Promise<string>;

export class PerplEnrollError extends Error {
  constructor(
    readonly stage: 'payload' | 'enroll',
    readonly status: number,
    detail: string,
  ) {
    super(`Perpl api-key ${stage} failed with HTTP ${status}: ${detail}`);
    this.name = 'PerplEnrollError';
  }
}

export interface EnrollPerplKeyOptions {
  network: PerplNetwork;
  /** The `Origin` Perpl has whitelisted for your integration. Required from a
   * server; a browser sets it itself. */
  origin: string;
  /** The wallet that owns (or operates) the exchange account. */
  walletAddress: string;
  signTypedData: WalletTypedDataSigner;
  label: string;
  scopeMask?: number;
  expiresAtMs?: number;
  ipCidrs?: string[];
  fetchImpl?: typeof fetch;
  restBaseUrl?: string;
  /** Inject a key pair for determinism; generated fresh by default. */
  keyPair?: Ed25519KeyPair;
}

export interface EnrolledPerplKey {
  /** The opaque `X-API-Key` token. Store it: it is not re-derivable. */
  apiKey: string;
  /** Ed25519 secret, hex. The caller is responsible for storing it safely. */
  secretKeyHex: string;
  publicKeyHex: string;
  info: PerplApiKeyInfo;
}

async function postJson(
  fetchImpl: typeof fetch,
  stage: 'payload' | 'enroll',
  url: string,
  origin: string,
  body: unknown,
): Promise<unknown> {
  const res = await fetchImpl(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: origin },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    let detail = res.statusText;
    try {
      detail = (await res.text()) || detail;
    } catch {
      // keep statusText
    }
    // 409 = public key already registered (revoked keys can never be
    // re-enrolled), 423 = 16 active keys already. Surfaced verbatim by the
    // server text; the caller decides, this layer never retries an enroll.
    throw new PerplEnrollError(stage, res.status, detail);
  }
  return res.json();
}

export async function enrollPerplApiKey(opts: EnrollPerplKeyOptions): Promise<EnrolledPerplKey> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const base = opts.restBaseUrl ?? PERPL_REST_BASE_URL[opts.network];
  const chainId = PERPL_CHAIN_ID[opts.network];
  const keyPair = opts.keyPair ?? (await generateEd25519KeyPair());

  const payloadRaw = await postJson(fetchImpl, 'payload', `${base}/v1/api-key/payload`, opts.origin, {
    chain_id: chainId,
    address: opts.walletAddress,
    public_key: keyPair.publicKeyHex,
    scope_mask: opts.scopeMask ?? PERPL_SCOPE.readTrade,
    label: opts.label,
    ...(opts.expiresAtMs !== undefined ? { expires_at: opts.expiresAtMs } : {}),
    ...(opts.ipCidrs !== undefined ? { ip_cidrs: opts.ipCidrs } : {}),
  });
  const { typed_data: typedData, mac } = PayloadResponseSchema.parse(payloadRaw);

  // ethers wants the types WITHOUT the EIP712Domain entry.
  const { EIP712Domain: _domainType, ...types } = typedData.types;

  const signature = await opts.signTypedData({ domain: typedData.domain, types, message: typedData.message });

  // Proof of possession: Ed25519 over the EIP-712 digest.
  const digest = ethers.utils._TypedDataEncoder.hash(typedData.domain, types, typedData.message);
  const popSignature = await signHexWithEd25519(keyPair.secretKeyHex, fromHex(digest));

  const enrollRaw = await postJson(fetchImpl, 'enroll', `${base}/v1/api-key/enroll`, opts.origin, {
    chain_id: chainId,
    address: opts.walletAddress,
    typed_data: typedData,
    mac,
    signature,
    pop_signature: popSignature,
  });
  const enrolled = EnrollResponseSchema.parse(enrollRaw);

  return {
    apiKey: enrolled.api_key.api_key,
    secretKeyHex: keyPair.secretKeyHex,
    publicKeyHex: keyPair.publicKeyHex,
    info: enrolled.api_key,
  };
}

/** Scripts and tests only. In the product the user's wallet signs. */
export function walletTypedDataSignerFromPrivateKey(privateKey: string): WalletTypedDataSigner {
  const wallet = new ethers.Wallet(privateKey);
  return (req) => wallet._signTypedData(req.domain, req.types, req.message);
}
