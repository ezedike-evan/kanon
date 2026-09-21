import { ethers } from 'ethers';
import { describe, expect, it } from 'vitest';
import { fromHex, generateEd25519KeyPair, toHex } from './perpl-auth';
import * as ed from '@noble/ed25519';
import { PerplEnrollError, PERPL_SCOPE, enrollPerplApiKey, walletTypedDataSignerFromPrivateKey } from './perpl-enroll';
import { fakeFetch } from './test-helpers';

// A throwaway key generated for this test file only. It holds nothing.
const WALLET_KEY = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d';
const wallet = new ethers.Wallet(WALLET_KEY);

/** Shaped like the documented server response: EIP-712 typed data plus an opaque mac. */
const typedData = {
  types: {
    EIP712Domain: [
      { name: 'name', type: 'string' },
      { name: 'version', type: 'string' },
      { name: 'chainId', type: 'uint256' },
    ],
    EnrollApiKey: [
      { name: 'publicKey', type: 'bytes' },
      { name: 'scopeMask', type: 'uint8' },
      { name: 'statement', type: 'string' },
    ],
  },
  primaryType: 'EnrollApiKey',
  domain: { name: 'Perpl', version: '1', chainId: 143 },
  message: { publicKey: '0x', scopeMask: 3, statement: 'Authorize this key' },
};

describe('enrollPerplApiKey', () => {
  it('runs payload -> wallet EIP-712 -> Ed25519 proof of possession -> enroll', async () => {
    const keyPair = await generateEd25519KeyPair();
    const message = { ...typedData.message, publicKey: keyPair.publicKeyHex };
    const served = { ...typedData, message };

    const { fetchImpl, calls } = fakeFetch((url) => {
      if (url.endsWith('/v1/api-key/payload')) return { body: { typed_data: served, mac: 'mac-opaque' } };
      if (url.endsWith('/v1/api-key/enroll')) {
        return { body: { api_key: { api_key: 'pk_live_token', address: wallet.address, scope_mask: 3, label: 'kanon' } } };
      }
      return undefined;
    });

    const out = await enrollPerplApiKey({
      network: 'mainnet',
      origin: 'https://kanon.example',
      walletAddress: wallet.address,
      signTypedData: walletTypedDataSignerFromPrivateKey(WALLET_KEY),
      label: 'kanon',
      keyPair,
      fetchImpl,
    });

    expect(out.apiKey).toBe('pk_live_token');
    expect(out.secretKeyHex).toBe(keyPair.secretKeyHex);

    // Request 1: payload, with the origin header and the documented body fields.
    expect(calls[0]?.url).toBe('https://app.perpl.xyz/api/v1/api-key/payload');
    expect((calls[0]?.init?.headers as Record<string, string>).Origin).toBe('https://kanon.example');
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({
      chain_id: 143,
      address: wallet.address,
      public_key: keyPair.publicKeyHex,
      scope_mask: PERPL_SCOPE.readTrade,
      label: 'kanon',
    });

    // Request 2: enroll echoes typed_data and mac unchanged and carries both signatures.
    const enrollBody = JSON.parse(String(calls[1]?.init?.body));
    expect(calls[1]?.url).toBe('https://app.perpl.xyz/api/v1/api-key/enroll');
    expect(enrollBody.typed_data).toEqual(served);
    expect(enrollBody.mac).toBe('mac-opaque');

    // The wallet signature recovers to the wallet, over the typed data with EIP712Domain stripped.
    const { EIP712Domain: _d, ...types } = served.types;
    const recovered = ethers.utils.verifyTypedData(served.domain, types, message, enrollBody.signature);
    expect(recovered).toBe(wallet.address);

    // The proof of possession verifies against the enrolled Ed25519 public key over the EIP-712 digest.
    const digest = ethers.utils._TypedDataEncoder.hash(served.domain, types, message);
    const pop = fromHex(enrollBody.pop_signature);
    expect(await ed.verifyAsync(pop, fromHex(digest), fromHex(keyPair.publicKeyHex))).toBe(true);
    expect(toHex(pop)).toHaveLength(128);
  });

  it('uses the testnet chain id and REST base', async () => {
    const { fetchImpl, calls } = fakeFetch(() => ({ status: 400, body: 'origin not whitelisted' }));
    await expect(
      enrollPerplApiKey({
        network: 'testnet',
        origin: 'https://nope.example',
        walletAddress: wallet.address,
        signTypedData: walletTypedDataSignerFromPrivateKey(WALLET_KEY),
        label: 'kanon',
        fetchImpl,
      }),
    ).rejects.toThrow(PerplEnrollError);
    expect(calls[0]?.url).toBe('https://testnet.perpl.xyz/api/v1/api-key/payload');
    expect(JSON.parse(String(calls[0]?.init?.body)).chain_id).toBe(10143);
  });

  it('surfaces a 409 (public key already registered) from enroll with its stage', async () => {
    const keyPair = await generateEd25519KeyPair();
    const { fetchImpl } = fakeFetch((url) =>
      url.endsWith('/payload')
        ? { body: { typed_data: { ...typedData, message: { ...typedData.message, publicKey: keyPair.publicKeyHex } }, mac: 'm' } }
        : { status: 409, body: 'public key already registered' },
    );
    const err = await enrollPerplApiKey({
      network: 'mainnet',
      origin: 'https://kanon.example',
      walletAddress: wallet.address,
      signTypedData: walletTypedDataSignerFromPrivateKey(WALLET_KEY),
      label: 'kanon',
      keyPair,
      fetchImpl,
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PerplEnrollError);
    expect((err as PerplEnrollError).stage).toBe('enroll');
    expect((err as PerplEnrollError).status).toBe(409);
  });
});
