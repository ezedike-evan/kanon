import { describe, expect, it } from 'vitest';
import { privateKeyToAccount } from 'viem/accounts';
import { recoverLinkedWallet, vaultAssetId, walletLinkMessage } from './wallet-link';

const account = privateKeyToAccount('0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d');

describe('wallet link', () => {
  it('recovers the signer of the link message, lower-cased', async () => {
    const signature = await account.signMessage({ message: walletLinkMessage('did:privy:abc') });
    expect(await recoverLinkedWallet('did:privy:abc', signature)).toBe(account.address.toLowerCase());
  });

  it('a signature for one account does not link another', async () => {
    const signature = await account.signMessage({ message: walletLinkMessage('did:privy:abc') });
    expect(await recoverLinkedWallet('did:privy:other', signature)).not.toBe(account.address.toLowerCase());
  });

  it('refuses a malformed signature', async () => {
    expect(await recoverLinkedWallet('did:privy:abc', '0x1234')).toBeNull();
    expect(await recoverLinkedWallet('did:privy:abc', 'nonsense')).toBeNull();
  });

  it('hashes an asset like the contract whitelist does', () => {
    expect(vaultAssetId('BTC/USD')).toMatch(/^0x[0-9a-f]{64}$/);
  });
});
