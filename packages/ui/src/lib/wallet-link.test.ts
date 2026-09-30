import { describe, expect, it, vi } from 'vitest';
import { recordWithWalletLink, replyFailed } from './wallet-link';

const deps = () => ({
  walletLinkMessage: vi.fn(async () => ({ message: 'sign me' })),
  signMessage: vi.fn(async () => '0xsig'),
});

describe('recordWithWalletLink', () => {
  it('passes a success straight through without signing', async () => {
    const d = deps();
    const call = vi.fn(async () => ({ ok: true, id: 'x' }));
    expect(await recordWithWalletLink(call, d)).toEqual({ ok: true, id: 'x' });
    expect(call).toHaveBeenCalledTimes(1);
    expect(d.signMessage).not.toHaveBeenCalled();
  });

  it('signs the server message and retries once when the wallet is not linked', async () => {
    const d = deps();
    const call = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, reason: 'wallet_not_linked' })
      .mockResolvedValueOnce({ ok: true, id: 'y' });
    expect(await recordWithWalletLink(call, d)).toEqual({ ok: true, id: 'y' });
    expect(d.signMessage).toHaveBeenCalledWith('sign me');
    expect(call).toHaveBeenNthCalledWith(2, { walletSignature: '0xsig' });
  });

  it('does not retry other failures, and does not loop', async () => {
    const d = deps();
    const call = vi.fn(async () => ({ ok: false, reason: 'rejected' }));
    await recordWithWalletLink(call, d);
    expect(call).toHaveBeenCalledTimes(1);
    const again = vi.fn(async () => ({ ok: false, reason: 'wallet_not_linked' }));
    await recordWithWalletLink(again, d);
    expect(again).toHaveBeenCalledTimes(2);
  });

  it('returns the failure when the client cannot sign', async () => {
    const call = vi.fn(async () => ({ ok: false, reason: 'wallet_not_linked' }));
    expect(replyFailed(await recordWithWalletLink(call, {}))).toBe(true);
    expect(call).toHaveBeenCalledTimes(1);
  });

  it('treats a reply with no ok flag as success', () => {
    expect(replyFailed(undefined)).toBe(false);
    expect(replyFailed({})).toBe(false);
  });
});
