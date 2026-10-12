import { describe, expect, it } from 'vitest';
import {
  DECIDING_NOT_EXACT,
  ONCHAIN_ROW_LIMIT,
  ONCHAIN_STRATEGY_LIMIT,
  blockTimeLabel,
  decidingReading,
  ownerKey,
  predicateLabel,
  readRecord,
  readStrategies,
  recordRequest,
  recordRows,
  recordTx,
  registryIdOf,
  rowSummary,
  shortSpecHash,
  strategiesRequest,
  type OnchainStrategy,
} from './onchain-record';

// Fixtures in the shape Envio's GraphQL API (Hasura) answers with: `{ data: { <Entity>: [rows] } }`,
// ids prefixed with the chain, addresses lowercase, `Int` as a number and `BigInt` as a string.
const CHAIN = 10143;
const hash = (c: string) => `0x${c.repeat(64)}`;
const SPEC_A = hash('a');
const SPEC_B = hash('b');
const SPEC_C = hash('c');

const event = (over: Record<string, unknown>) => ({
  id: `${CHAIN}_100_0`,
  strategy_id: `${CHAIN}_3`,
  kind: 'PINNED',
  oldSpecHash: null,
  newSpecHash: SPEC_A,
  cooldownEndsAt: null,
  timestamp: 1_760_000_000,
  blockNumber: 100,
  logIndex: 0,
  txHash: hash('1'),
  ...over,
});
const refusal = (over: Record<string, unknown>) => ({
  id: `${CHAIN}_200_4`,
  strategy_id: `${CHAIN}_3`,
  specHash: SPEC_A,
  predicate: 'fvg_present',
  decidingValue: '12',
  timestamp: 1_760_000_600,
  blockNumber: 200,
  logIndex: 4,
  txHash: hash('2'),
  ...over,
});
const answer = (events: unknown[], refusals: unknown[]) => ({ data: { StrategyEvent: events, Refusal: refusals } });
const RULE: OnchainStrategy = { key: `${CHAIN}_3`, registryId: '3', activeSpecHash: SPEC_A, pendingSpecHash: null };

describe('what is asked', () => {
  it('stores an address the way the indexer does, and takes nothing else for one', () => {
    expect(ownerKey('0xAbCdEf0123456789aBcDeF0123456789ABCDEF01')).toBe('0xabcdef0123456789abcdef0123456789abcdef01');
    expect(ownerKey('  0xabcdef0123456789abcdef0123456789abcdef01 ')).toBe('0xabcdef0123456789abcdef0123456789abcdef01');
    for (const bad of [null, undefined, '', '0x12', 'abcdef0123456789abcdef0123456789abcdef01', `0x${'g'.repeat(40)}`]) {
      expect(ownerKey(bad), String(bad)).toBeNull();
    }
  });

  it("asks for the wallet's rules by owner, on the app's chain", () => {
    const req = strategiesRequest(CHAIN, '0xabcdef0123456789abcdef0123456789abcdef01');
    expect(req.operationName).toBe('KanonOnchainStrategies');
    expect(req.variables).toEqual({
      chainId: CHAIN,
      owner: '0xabcdef0123456789abcdef0123456789abcdef01',
      limit: ONCHAIN_STRATEGY_LIMIT,
    });
    expect(req.query).toContain('where: { chainId: { _eq: $chainId }, owner: { _eq: $owner } }');
    expect(req.query).toContain('order_by: [{ pinnedAt: desc }]');
  });

  it('asks for every event and refusal of those rules, newest first, with the block breaking a tie in time', () => {
    const req = recordRequest(CHAIN, [`${CHAIN}_3`, `${CHAIN}_7`]);
    expect(req.operationName).toBe('KanonOnchainRecord');
    expect(req.variables).toEqual({ chainId: CHAIN, strategies: [`${CHAIN}_3`, `${CHAIN}_7`], limit: ONCHAIN_ROW_LIMIT });
    const filter = 'where: { chainId: { _eq: $chainId }, strategy_id: { _in: $strategies } }';
    const order = 'order_by: [{ timestamp: desc }, { blockNumber: desc }, { logIndex: desc }]';
    expect(req.query.split(filter)).toHaveLength(3);
    expect(req.query.split(order)).toHaveLength(3);
    expect(req.query).toMatch(/StrategyEvent\([\s\S]*Refusal\(/);
    // Every field a row is drawn from is asked for by the name the schema gives it.
    for (const field of ['kind', 'oldSpecHash', 'newSpecHash', 'cooldownEndsAt', 'predicate', 'decidingValue', 'txHash']) {
      expect(req.query, field).toContain(field);
    }
  });
});

describe('the rules that come back', () => {
  it("reads each rule's id in the registry and the hashes it holds now", () => {
    const read = readStrategies(
      {
        data: {
          Strategy: [
            { id: `${CHAIN}_7`, strategyId: '7', activeSpecHash: SPEC_B, pendingSpecHash: SPEC_C },
            { id: `${CHAIN}_3`, strategyId: '3', activeSpecHash: SPEC_A, pendingSpecHash: null },
          ],
        },
      },
      CHAIN,
    );
    expect(read).toEqual({
      strategies: [
        { key: `${CHAIN}_7`, registryId: '7', activeSpecHash: SPEC_B, pendingSpecHash: SPEC_C },
        { key: `${CHAIN}_3`, registryId: '3', activeSpecHash: SPEC_A, pendingSpecHash: null },
      ],
      seen: 2,
    });
  });

  it("leaves out a rule from another chain and one whose id is not the registry's", () => {
    const read = readStrategies(
      { data: { Strategy: [{ id: '143_3' }, { id: `${CHAIN}_abc` }, { id: 9 }, null, { id: `${CHAIN}_3` }] } },
      CHAIN,
    );
    expect(read?.strategies.map((s) => s.key)).toEqual([`${CHAIN}_3`]);
    expect(read?.seen).toBe(5);
  });

  it('is an empty list for a wallet with nothing on-chain, and null for a body that is not the answer', () => {
    expect(readStrategies({ data: { Strategy: [] } }, CHAIN)).toEqual({ strategies: [], seen: 0 });
    // Hasura answers a query it cannot run with HTTP 200 and `errors`.
    const refused = {
      errors: [
        {
          message: "field 'Strategy' not found in type: 'query_root'",
          extensions: { path: '$.selectionSet.Strategy', code: 'validation-failed' },
        },
      ],
    };
    for (const bad of [refused, { data: null }, { data: {} }, { data: { Strategy: {} } }, 'nope', null, []]) {
      expect(readStrategies(bad, CHAIN), JSON.stringify(bad)).toBeNull();
    }
  });
});

describe('the events and refusals that come back', () => {
  it('reads each kind of change, with times in milliseconds', () => {
    const read = readRecord(
      answer(
        [
          event({}),
          event({ id: `${CHAIN}_110_1`, kind: 'TIGHTENED', oldSpecHash: SPEC_A, newSpecHash: SPEC_B, blockNumber: 110, logIndex: 1 }),
          event({
            id: `${CHAIN}_120_2`,
            kind: 'LOOSENING_PROPOSED',
            oldSpecHash: SPEC_B,
            newSpecHash: SPEC_C,
            cooldownEndsAt: 1_760_086_400,
            blockNumber: 120,
            logIndex: 2,
          }),
          event({ id: `${CHAIN}_130_0`, kind: 'LOOSENING_FINALIZED', oldSpecHash: SPEC_B, newSpecHash: SPEC_C, blockNumber: 130 }),
        ],
        [],
      ),
    );
    expect(read?.events.map((e) => [e.kind, e.fromHash, e.specHash, e.holdEndsAt])).toEqual([
      ['pinned', null, SPEC_A, null],
      ['tightened', SPEC_A, SPEC_B, null],
      ['loosening_proposed', SPEC_B, SPEC_C, 1_760_086_400_000],
      ['loosening_finalized', SPEC_B, SPEC_C, null],
    ]);
    expect(read?.events[0]).toMatchObject({
      id: `event:${CHAIN}_100_0`,
      strategyKey: `${CHAIN}_3`,
      at: 1_760_000_000_000,
      blockNumber: 100,
      logIndex: 0,
      txHash: hash('1'),
      predicate: null,
      decidingValue: null,
    });
    expect(read?.eventsSeen).toBe(4);
  });

  it('reads a refusal with its predicate and its number, digit for digit', () => {
    const read = readRecord(
      answer(
        [],
        [
          refusal({}),
          // A wick price: larger than a float holds exactly, so it is only good as a string.
          refusal({ id: `${CHAIN}_201_0`, predicate: 'sweep_low', decidingValue: '6412050000000123456789' }),
          refusal({ id: `${CHAIN}_202_0`, predicate: 'bos_bullish', decidingValue: 6_412_050 }),
          refusal({ id: `${CHAIN}_203_0`, predicate: 'bos_bearish', decidingValue: '-5' }),
        ],
      ),
    );
    expect(read?.refusals.map((r) => [r.kind, r.predicate, r.decidingValue])).toEqual([
      ['refused', 'fvg_present', '12'],
      ['refused', 'sweep_low', '6412050000000123456789'],
      ['refused', 'bos_bullish', '6412050'],
      ['refused', 'bos_bearish', '-5'],
    ]);
    expect(read?.refusals[0]).toMatchObject({ id: `refusal:${CHAIN}_200_4`, specHash: SPEC_A, at: 1_760_000_600_000, txHash: hash('2') });
  });

  it('keeps a refusal whose number was rounded on the way, without the number', () => {
    const read = readRecord(answer([], [refusal({ decidingValue: 6.412050000000123e21 }), refusal({ decidingValue: '1.5' }), refusal({ decidingValue: null })]));
    expect(read?.refusals.map((r) => r.decidingValue)).toEqual([null, null, null]);
  });

  it('leaves out a row it cannot draw: no transaction, no time, no hash, a kind it does not know, no predicate', () => {
    const read = readRecord(
      answer(
        [
          event({ txHash: '0x12' }),
          event({ timestamp: '1760000000' }),
          event({ newSpecHash: null }),
          event({ kind: 'RETIRED' }),
          event({ kind: 'toString' }),
          event({ strategy_id: 3 }),
          null,
          event({ id: `${CHAIN}_140_0` }),
        ],
        [refusal({ predicate: '' }), refusal({ specHash: 'nope' }), refusal({ blockNumber: -1 }), refusal({ id: `${CHAIN}_210_0` })],
      ),
    );
    expect(read?.events.map((e) => e.id)).toEqual([`event:${CHAIN}_140_0`]);
    expect(read?.refusals.map((r) => r.id)).toEqual([`refusal:${CHAIN}_210_0`]);
    // What came back is still counted, so a full list is known to be full.
    expect([read?.eventsSeen, read?.refusalsSeen]).toEqual([8, 4]);
  });

  it('is null for a body that is not the answer', () => {
    const bodies = [
      { errors: [{ message: 'boom' }] },
      { data: { StrategyEvent: [] } },
      { data: { Refusal: [] } },
      { data: { StrategyEvent: [], Refusal: null } },
      { StrategyEvent: [], Refusal: [] },
      undefined,
    ];
    for (const bad of bodies) expect(readRecord(bad), JSON.stringify(bad)).toBeNull();
    expect(readRecord(answer([], []))).toEqual({ events: [], refusals: [], eventsSeen: 0, refusalsSeen: 0 });
  });
});

describe('the record', () => {
  const rowsOf = (events: unknown[], refusals: unknown[], strategies: OnchainStrategy[] = [RULE], limit?: number) => {
    const read = readRecord(answer(events, refusals));
    if (!read) throw new Error('fixture is not an answer');
    return recordRows(strategies, read, limit);
  };

  it('is one list, newest first, the two kinds interleaved', () => {
    const { rows, truncated } = rowsOf(
      [event({}), event({ id: `${CHAIN}_300_0`, kind: 'TIGHTENED', oldSpecHash: SPEC_A, newSpecHash: SPEC_B, timestamp: 1_760_001_200, blockNumber: 300 })],
      [refusal({})],
    );
    expect(rows.map((r) => r.kind)).toEqual(['tightened', 'refused', 'pinned']);
    expect(truncated).toBe(false);
  });

  it('orders rows of the same second by block, then by position in the block', () => {
    // Monad's blocks are 400 ms apart, so one second holds more than one.
    const same = { timestamp: 1_760_000_000 };
    const { rows } = rowsOf(
      [event({ ...same, id: 'a', blockNumber: 100, logIndex: 5 }), event({ ...same, id: 'b', blockNumber: 101, logIndex: 0 })],
      [refusal({ ...same, id: 'c', blockNumber: 100, logIndex: 9 }), refusal({ ...same, id: 'd', blockNumber: 102, logIndex: 1 })],
    );
    expect(rows.map((r) => r.id)).toEqual(['refusal:d', 'event:b', 'refusal:c', 'event:a']);
  });

  it('marks the change that set the hash in force, and the proposal still waiting, once each', () => {
    const strategy: OnchainStrategy = { ...RULE, activeSpecHash: SPEC_B, pendingSpecHash: SPEC_C };
    const { rows } = rowsOf(
      [
        event({ id: 'pin' }),
        event({ id: 'tighten', kind: 'TIGHTENED', oldSpecHash: SPEC_A, newSpecHash: SPEC_B, timestamp: 1_760_000_100, blockNumber: 110 }),
        // An earlier proposal of the same hash, since replaced: only the newest one is the one waiting.
        event({ id: 'old-ask', kind: 'LOOSENING_PROPOSED', newSpecHash: SPEC_C, timestamp: 1_760_000_200, blockNumber: 120 }),
        event({ id: 'ask', kind: 'LOOSENING_PROPOSED', newSpecHash: SPEC_C, timestamp: 1_760_000_300, blockNumber: 130 }),
      ],
      [refusal({ specHash: SPEC_B })],
      [strategy],
    );
    expect(rows.map((r) => [r.id, r.mark])).toEqual([
      ['refusal:10143_200_4', null],
      ['event:ask', 'cooling_off'],
      ['event:old-ask', null],
      ['event:tighten', 'enforcing'],
      ['event:pin', null],
    ]);
  });

  it('marks nothing as waiting once the registry holds no pending hash', () => {
    const { rows } = rowsOf([event({ id: 'ask', kind: 'LOOSENING_PROPOSED', newSpecHash: SPEC_C })], []);
    expect(rows.map((r) => r.mark)).toEqual([null]);
  });

  it("leaves out a row of a rule that was not asked about: it is not this wallet's", () => {
    const { rows } = rowsOf([event({}), event({ id: 'other', strategy_id: `${CHAIN}_99` })], [refusal({ strategy_id: `${CHAIN}_99` })]);
    expect(rows.map((r) => r.id)).toEqual([`event:${CHAIN}_100_0`]);
  });

  it('stops where a full list was cut, so no stretch of history is shown with half of it missing', () => {
    // Three refusals came back for a limit of three: there may be older ones. The pin is older than
    // the oldest refusal read, so the refusals between them are unknown and the pin is not shown.
    const { rows, truncated } = rowsOf(
      [event({ id: 'pin', timestamp: 1_760_000_000 }), event({ id: 'tighten', kind: 'TIGHTENED', newSpecHash: SPEC_B, timestamp: 1_760_000_650, blockNumber: 250 })],
      [
        refusal({ id: 'r3', timestamp: 1_760_000_700, blockNumber: 260 }),
        refusal({ id: 'r2', timestamp: 1_760_000_660, blockNumber: 255 }),
        refusal({ id: 'r1', timestamp: 1_760_000_600, blockNumber: 240 }),
      ],
      [RULE],
      3,
    );
    expect(rows.map((r) => r.id)).toEqual(['refusal:r3', 'refusal:r2', 'event:tighten', 'refusal:r1']);
    expect(truncated).toBe(true);
  });

  it('is whole when neither list came back full', () => {
    const { rows, truncated } = rowsOf([event({ id: 'pin' })], [refusal({ id: 'r1' }), refusal({ id: 'r2', timestamp: 1_760_000_700 })], [RULE], 3);
    expect(rows).toHaveLength(3);
    expect(truncated).toBe(false);
  });
});

describe('how a row reads', () => {
  it('says what a refusal number is only where the contract fixes it', () => {
    expect(decidingReading('fvg_present', '12')).toEqual({ figure: '12', unit: 'bps', words: null });
    // A close and a wick are the series' own integers: shown as emitted, with no unit claimed.
    expect(decidingReading('bos_bullish', '6412050000000')).toEqual({ figure: '6412050000000', unit: null, words: null });
    expect(decidingReading('sweep_low', '-5')).toEqual({ figure: '-5', unit: null, words: null });
    expect(decidingReading('SIDE_MISMATCH', '1').words).toBe('The rule takes longs only.');
    expect(decidingReading('SIDE_MISMATCH', '0').words).toBe('The rule takes shorts only.');
    expect(decidingReading('RETIRED', '0')).toEqual({ figure: null, unit: null, words: 'The rule is retired.' });
    expect(decidingReading('bos_bullish', null)).toEqual({ figure: null, unit: null, words: DECIDING_NOT_EXACT });
  });

  it('shows a predicate as emitted, and shortens one that is not text', () => {
    expect(predicateLabel('bos_bullish')).toBe('bos_bullish');
    expect(predicateLabel(hash('f'))).toBe('0xffffff…ffff');
  });

  it("links a row to its transaction on the configured chain's explorer", () => {
    const tx = recordTx({ name: 'Monadscan', url: 'https://testnet.monadscan.com/' }, hash('2'));
    expect(tx).toEqual({
      hash: hash('2'),
      short: '0x222222…2222',
      url: `https://testnet.monadscan.com/tx/${hash('2')}`,
      explorer: 'Monadscan',
    });
  });

  it('labels a block time, a hash and a rule the way the rule cards do', () => {
    expect(blockTimeLabel(1_760_000_600_000)).toBe('2025-10-09 09:03 UTC');
    expect(shortSpecHash(SPEC_A)).toBe('0xaaaaaa…aaaa');
    expect(registryIdOf(`${CHAIN}_3`)).toBe('3');
    expect(registryIdOf('3')).toBe('3');
  });

  it('says a row in one sentence for a screen reader', () => {
    const tx = recordTx({ name: 'Monadscan', url: 'https://testnet.monadscan.com' }, hash('2'));
    const read = readRecord(answer([event({})], [refusal({})]));
    expect(rowSummary(read!.refusals[0]!, tx)).toBe('Refused, fvg_present, 2025-10-09 09:03 UTC, transaction 0x222222…2222 on Monadscan');
    expect(rowSummary(read!.events[0]!, tx)).toBe('Pinned, 2025-10-09 08:53 UTC, transaction 0x222222…2222 on Monadscan');
  });
});
