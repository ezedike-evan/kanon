/**
 * Recording a chain action on the server needs the server to know which wallet
 * is yours. The first time, the backend answers `wallet_not_linked`; this signs
 * the server's own link message with the wallet (no funds, no permission) and
 * retries once. After that the link is stored and never asked for again.
 */

export interface WalletLinkDeps {
  /** `users.walletLinkChallenge`: the exact text the wallet must sign. */
  walletLinkMessage?: (() => Promise<{ message: string }>) | undefined;
  /** Signs text with the connected wallet (`personal_sign`). */
  signMessage?: ((message: string) => Promise<string>) | undefined;
}

type Extra = { walletSignature?: string };

/** Replies are `{ ok: false, reason }` from the verifying actions; a fake or an older reply with no `ok` counts as success. */
export function replyFailed(reply: unknown): reply is { ok: false; reason?: string; message?: string } {
  return typeof reply === 'object' && reply !== null && (reply as { ok?: unknown }).ok === false;
}

/**
 * Runs `call`; on `wallet_not_linked` signs the link message and runs it once
 * more with the signature. Returns the final reply. Throws whatever `call` or
 * the wallet throws (a declined signature is an error the caller already handles).
 */
export async function recordWithWalletLink(
  call: (extra: Extra) => Promise<unknown>,
  deps: WalletLinkDeps,
): Promise<unknown> {
  const first = await call({});
  if (!replyFailed(first) || first.reason !== 'wallet_not_linked') return first;
  if (!deps.walletLinkMessage || !deps.signMessage) return first;
  const { message } = await deps.walletLinkMessage();
  const walletSignature = await deps.signMessage(message);
  return await call({ walletSignature });
}
