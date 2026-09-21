import { describe, expect, it } from 'vitest';
import type { ChainPort, LogQuery } from './port';
import { createLogSource, PartialDiscoveryError } from './source';

const MARGIN = '0x1111111111111111111111111111111111111111' as const;
const A: `0x${string}` = '0x00000000000000000000000000000000000000aa';
const B: `0x${string}` = '0x00000000000000000000000000000000000000bb';

function portWith(head: () => bigint, events: { block: bigint; account: string }[], failAt?: () => bigint | undefined) {
  const queries: LogQuery[] = [];
  const port = {
    blockNumber: async () => head(),
    getLogs: async (q: LogQuery) => {
      queries.push(q);
      if (failAt?.() === q.fromBlock) throw new Error('range too large');
      return events
        .filter((e) => e.block >= q.fromBlock && e.block <= q.toBlock)
        .map((e) => ({ blockNumber: e.block, args: { account: e.account } }));
    },
  } as unknown as ChainPort;
  return { port, queries };
}

const opts = { marginAddress: MARGIN, startBlock: 100n, rangeBlocks: 50n, reorgDepth: 4n };

describe('createLogSource', () => {
  it('scans from the start block to head in bounded chunks and de-duplicates accounts', async () => {
    const { port, queries } = portWith(() => 230n, [
      { block: 105n, account: A },
      { block: 160n, account: B },
      { block: 220n, account: A },
    ]);
    const src = createLogSource(opts);
    const r = await src.poll(port);
    expect(queries.map((q) => [q.fromBlock, q.toBlock])).toEqual([
      [100n, 149n],
      [150n, 199n],
      [200n, 230n],
    ]);
    expect(queries.every((q) => q.address === MARGIN && q.eventName === 'PositionOpened')).toBe(true);
    expect(r.accounts.sort()).toEqual([A, B]);
    expect(r.fromBlock).toBe(100n);
    expect(r.toBlock).toBe(230n);
    expect(src.cursor()).toBe(230n);
  });

  it('resumes behind the cursor by the reorg depth and only re-scans that tail', async () => {
    let head = 230n;
    const events = [{ block: 227n, account: A }];
    const { port, queries } = portWith(() => head, events);
    const src = createLogSource(opts);
    await src.poll(port);
    queries.length = 0;
    head = 240n;
    events.push({ block: 236n, account: B });
    const r = await src.poll(port);
    expect(queries.map((q) => [q.fromBlock, q.toBlock])).toEqual([[227n, 240n]]);
    expect(r.accounts.sort()).toEqual([A, B]);
  });

  it('never scans below the start block', async () => {
    const { port, queries } = portWith(() => 102n, []);
    const src = createLogSource({ ...opts, reorgDepth: 50n });
    await src.poll(port);
    await src.poll(port);
    expect(queries.every((q) => q.fromBlock >= 100n)).toBe(true);
  });

  it('does nothing when head is behind the start block', async () => {
    const { port, queries } = portWith(() => 10n, []);
    const r = await createLogSource(opts).poll(port);
    expect(r.accounts).toEqual([]);
    expect(queries).toHaveLength(0);
  });

  it('keeps chunk progress when a later chunk fails and resumes from there', async () => {
    let fail: bigint | undefined = 150n;
    const { port, queries } = portWith(() => 230n, [{ block: 110n, account: A }], () => fail);
    const src = createLogSource({ ...opts, reorgDepth: 0n });
    await expect(src.poll(port)).rejects.toBeInstanceOf(PartialDiscoveryError);
    expect(src.cursor()).toBe(149n);
    fail = undefined;
    queries.length = 0;
    await src.poll(port);
    expect(queries[0]?.fromBlock).toBe(150n);
  });

  it('exposes what the earlier chunks found on a partial failure', async () => {
    const { port } = portWith(() => 230n, [{ block: 110n, account: A }], () => 150n);
    const err = await createLogSource(opts).poll(port).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PartialDiscoveryError);
    expect((err as PartialDiscoveryError).accounts).toEqual([A]);
  });
});
