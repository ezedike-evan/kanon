/**
 * Proof that a Privy user controls an on-chain wallet.
 *
 * Convex only knows the Privy DID. To tie a chain-mirroring row to a user the
 * server needs an address it can trust, so the wallet signs this one message
 * (EIP-191 `personal_sign`) and the server recovers the signer. The message
 * names the DID, so a signature cannot be replayed onto another account.
 */

import { getAddress, keccak256, recoverMessageAddress, stringToBytes, type Hex } from 'viem';
import { vaultAssetKey } from './vault';

/** The exact text the wallet signs. No timestamp: the link is permanent per user, and first link wins. */
export function walletLinkMessage(subject: string): string {
  return `Link this wallet to Kanon account ${subject}.\nThis does not move funds or grant any permission.`;
}

/** The lower-cased address that signed `walletLinkMessage(subject)`, or `null` if the signature is not valid. */
export async function recoverLinkedWallet(subject: string, signature: string): Promise<string | null> {
  if (!/^0x[0-9a-fA-F]{130}$/.test(signature)) return null;
  try {
    const address = await recoverMessageAddress({
      message: walletLinkMessage(subject),
      signature: signature as Hex,
    });
    return getAddress(address).toLowerCase();
  } catch {
    return null;
  }
}

/** `keccak256("BTC-USD")` — what the vault contract's whitelist stores for `BTC/USD`. */
export function vaultAssetId(symbol: string): Hex {
  return keccak256(stringToBytes(vaultAssetKey(symbol)));
}
