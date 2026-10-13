import { RECORDER_HEADER, createConvexRecorder } from './convex-recorder';
import type { LogRecord } from './log';

const SITE = 'https://example-123.convex.site';
const KEY = 'recorder-key-'.repeat(4);
const TOKEN = 'aaa.bbb.ccc';

interface Call {
  url: string;
  headers: Record<string, string>;
  body: unknown;
}

function setup(answer: (call: Call) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const logs: LogRecord[] = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    const call: Call = {
      url: String(url),
      headers: Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>)),
      body: JSON.parse(String(init?.body ?? 'null')),
    };
    calls.push(call);
    return answer(call);
  }) as typeof fetch;
  const recorder = createConvexRecorder({ siteUrl: `${SITE}/`, recorderKey: KEY, log: (entry) => logs.push(entry), fetchImpl });
  return { recorder, calls, logs };
}

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });
const open = { network: 'testnet', asset: 'BTC/USD', action: 'open', side: 'long', notionalUsd: 25, leverage: 2 } as const;

describe('admit', () => {
  it("asks the backend with the recorder key and the caller's own token", async () => {
    const { recorder, calls } = setup(() => json(200, { ok: true }));
    expect(await recorder.admit(TOKEN)).toEqual({ ok: true });
    expect(calls).toEqual([
      {
        url: `${SITE}/venue/admit`,
        headers: { 'content-type': 'application/json', [RECORDER_HEADER]: KEY, authorization: `Bearer ${TOKEN}` },
        body: {},
      },
    ]);
  });

  it('reads a token the backend turns away, and a rate limit, as what they are', async () => {
    expect(await setup(() => json(401, { ok: false, code: 'unauthenticated' })).recorder.admit(TOKEN)).toEqual({
      ok: false,
      code: 'unauthenticated',
    });
    const limited = { ok: false, code: 'rate_limited', retryAfterMs: 60_000, message: 'Rate limit reached for now.' };
    expect(await setup(() => json(200, limited)).recorder.admit(TOKEN)).toEqual(limited);
  });

  it('treats a wrong key, an unconfigured backend and no answer as unreachable, and logs no secret', async () => {
    for (const answer of [
      () => json(403, { ok: false, code: 'forbidden' }),
      () => json(503, { ok: false, code: 'not_configured' }),
      () => new Response('<html>bad gateway</html>', { status: 502 }),
      () => json(200, { unexpected: true }),
      () => {
        throw new Error('connect ECONNREFUSED');
      },
    ]) {
      const { recorder, logs } = setup(answer);
      expect(await recorder.admit(TOKEN)).toEqual({ ok: false, code: 'unreachable' });
      expect(logs).toHaveLength(1);
      expect(logs[0]?.level).toBe('error');
      expect(JSON.stringify(logs)).not.toContain(KEY);
      expect(JSON.stringify(logs)).not.toContain(TOKEN);
    }
  });
});

describe('begin', () => {
  it('sends the order and returns the row it is recorded under', async () => {
    const { recorder, calls } = setup(() => json(200, { ok: true, orderId: 'k17abc' }));
    expect(await recorder.forCaller(TOKEN).begin(open)).toEqual({ ok: true, orderId: 'k17abc' });
    expect(calls[0]).toMatchObject({ url: `${SITE}/venue/begin`, body: open });
    expect(calls[0]?.headers.authorization).toBe(`Bearer ${TOKEN}`);
    // Who the order is for is the token's to say. The body names nobody.
    expect(Object.keys(calls[0]?.body as object).sort()).toEqual(['action', 'asset', 'leverage', 'network', 'notionalUsd', 'side']);
  });

  it('passes on each typed no', async () => {
    const limited = { ok: false, code: 'rate_limited', retryAfterMs: 1_000, message: 'Rate limit reached for now.' };
    const cases: Array<[Response, unknown]> = [
      [json(200, { ok: false, code: 'busy' }), { ok: false, code: 'busy' }],
      [json(200, { ok: false, code: 'no_user' }), { ok: false, code: 'no_user' }],
      [json(200, limited), limited],
      [json(401, { ok: false, code: 'unauthenticated' }), { ok: false, code: 'unauthenticated' }],
      [json(400, { ok: false, code: 'bad_request' }), { ok: false, code: 'unreachable' }],
      [json(200, { ok: true }), { ok: false, code: 'unreachable' }],
    ];
    for (const [response, expected] of cases) {
      expect(await setup(() => response).recorder.forCaller(TOKEN).begin(open)).toEqual(expected);
    }
  });
});

describe('settle', () => {
  const outcome = { orderId: 'k17abc', status: 'refused', reason: 'The account holds no BTC position.' } as const;

  it('writes the outcome with the key alone, so a token that lapsed mid-order loses nothing', async () => {
    const { recorder, calls } = setup(() => json(200, { ok: true }));
    await recorder.forCaller(TOKEN).settle(outcome);
    expect(calls[0]).toMatchObject({ url: `${SITE}/venue/settle`, body: outcome });
    expect(calls[0]?.headers[RECORDER_HEADER]).toBe(KEY);
    expect(calls[0]?.headers.authorization).toBeUndefined();
  });

  it('throws when the outcome was not written, so the caller can say so', async () => {
    for (const answer of [
      () => json(500, { ok: false, code: 'failed' }),
      () => {
        throw new Error('socket hang up');
      },
    ]) {
      await expect(setup(answer).recorder.forCaller(TOKEN).settle(outcome)).rejects.toThrow(/k17abc could not be recorded/);
    }
  });
});

describe('amend', () => {
  const details = { orderId: 'k17abc', fee: { atoms: '8575', decimals: 6 }, block: 69822923, txHash: `0x${'33f4cfdc'.repeat(8)}` };

  it("adds a fill's figures to its record with the key alone", async () => {
    const { recorder, calls } = setup(() => json(200, { ok: true }));
    await recorder.forCaller(TOKEN).amend?.(details);
    expect(calls[0]).toMatchObject({ url: `${SITE}/venue/amend`, body: details });
    expect(calls[0]?.headers.authorization).toBeUndefined();
  });

  it('throws when they were not written', async () => {
    await expect(setup(() => json(500, { ok: false, code: 'failed' })).recorder.forCaller(TOKEN).amend?.(details)).rejects.toThrow(
      /k17abc could not be added/,
    );
  });
});

describe('timed trades', () => {
  const trade = {
    network: 'testnet',
    asset: 'BTC/USD',
    direction: 'up',
    stakeUsd: 25,
    leverage: 5,
    seconds: 60,
    openedAt: 1_000_000,
    expiresAt: 1_060_000,
    size: { atoms: '30', decimals: 5 },
    entryPrice: { atoms: '828471', decimals: 1 },
  } as const;

  it("writes a trade that has opened under the caller's own token", async () => {
    const { recorder, calls } = setup(() => json(200, { ok: true, tradeId: 'k27trade' }));
    expect(await recorder.timed.start({ token: TOKEN }, trade)).toBe('k27trade');
    expect(calls[0]).toMatchObject({ url: `${SITE}/timed/start`, body: trade });
    expect(calls[0]?.headers.authorization).toBe(`Bearer ${TOKEN}`);
    // Whose trade it is comes from the token. The body names nobody.
    expect(Object.keys(calls[0]?.body as object)).not.toContain('userId');
  });

  it('answers null when the trade could not be written, whatever the reason', async () => {
    for (const answer of [() => json(401, { ok: false, code: 'unauthenticated' }), () => json(200, { ok: false, code: 'no_user' }), () => { throw new Error('down'); }]) {
      expect(await setup(answer).recorder.timed.start({ token: TOKEN }, trade)).toBeNull();
    }
  });

  it("takes the lock for a trade's closing order with the key and the trade's id, and no token", async () => {
    const { recorder, calls } = setup(() => json(200, { ok: true, orderId: 'k17close' }));
    const closer = recorder.timed.closerFor('k27trade');
    expect(await closer.begin({ network: 'testnet', asset: 'BTC/USD', action: 'close' })).toEqual({ ok: true, orderId: 'k17close' });
    expect(calls[0]).toMatchObject({ url: `${SITE}/timed/begin-close`, body: { tradeId: 'k27trade', network: 'testnet', asset: 'BTC/USD' } });
    expect(calls[0]?.headers.authorization).toBeUndefined();
    expect(calls[0]?.headers[RECORDER_HEADER]).toBe(KEY);
    // The closing order's own record goes where every order's does.
    await closer.settle({ orderId: 'k17close', status: 'filled' });
    expect(calls[1]?.url).toBe(`${SITE}/venue/settle`);
  });

  it('passes on a lock that is taken', async () => {
    const { recorder } = setup(() => json(200, { ok: false, code: 'busy' }));
    expect(await recorder.timed.closerFor('k27trade').begin({ network: 'testnet', asset: 'BTC/USD', action: 'close' })).toEqual({ ok: false, code: 'busy' });
  });

  it('writes how a trade ended, and throws when that was not written', async () => {
    const update = { tradeId: 'k27trade', status: 'closed', endedBy: 'time', closedAt: 1_060_000 } as const;
    const { recorder, calls } = setup(() => json(200, { ok: true }));
    await recorder.timed.update(update);
    expect(calls[0]).toMatchObject({ url: `${SITE}/timed/update`, body: update });
    await expect(setup(() => json(500, { ok: false, code: 'failed' })).recorder.timed.update(update)).rejects.toThrow(/k27trade could not be written/);
  });

  it('reads the trades still running, and leaves out a row it cannot read', async () => {
    const row = { id: 'k27trade', ...trade, openFee: { atoms: '8575', decimals: 6 } };
    const { recorder } = setup(() => json(200, { ok: true, trades: [row, { id: 'broken' }, { ...row, id: 'k27other', openFee: undefined }] }));
    const running = await recorder.timed.running();
    expect(running.map((t) => t.id)).toEqual(['k27trade', 'k27other']);
    expect(running[0]?.openFee).toEqual({ atoms: '8575', decimals: 6 });
    expect('openFee' in (running[1] ?? {})).toBe(false);
    await expect(setup(() => json(403, { ok: false, code: 'forbidden' })).recorder.timed.running()).rejects.toThrow();
  });

  it("asks whether a trade is the caller's", async () => {
    expect(await setup(() => json(200, { ok: true, owns: true })).recorder.timed.owns(TOKEN, 'k27trade')).toBe(true);
    expect(await setup(() => json(200, { ok: true, owns: false })).recorder.timed.owns(TOKEN, 'k27trade')).toBe(false);
    expect(await setup(() => json(401, { ok: false, code: 'unauthenticated' })).recorder.timed.owns(TOKEN, 'k27trade')).toBe(false);
    await expect(setup(() => json(500, {})).recorder.timed.owns(TOKEN, 'k27trade')).rejects.toThrow();
  });
});

describe('autopilot: a trade opened for a proposal, with nobody signed in', () => {
  const PROPOSAL = 'k57proposal';
  const trade = {
    network: 'testnet',
    asset: 'BTC/USD',
    direction: 'up',
    stakeUsd: 10,
    leverage: 5,
    seconds: 900,
    openedAt: 1_000_000,
    expiresAt: 1_900_000,
    size: { atoms: '60', decimals: 5 },
    entryPrice: { atoms: '828471', decimals: 1 },
  } as const;
  const order = { network: 'testnet', asset: 'BTC/USD', action: 'open', side: 'long', notionalUsd: 50, leverage: 5 } as const;

  it('reads the proposals that are waiting, and leaves out a row it cannot read', async () => {
    const row = { proposalId: PROPOSAL, asset: 'BTC/USD', direction: 'up', stakeUsd: 10, seconds: 900 };
    const { recorder, calls } = setup(() =>
      json(200, { ok: true, proposals: [row, { proposalId: 'broken' }, { ...row, proposalId: 'k57other', direction: 'sideways' }] }),
    );
    expect(await recorder.autopilot.pending()).toEqual([row]);
    expect(calls[0]).toMatchObject({ url: `${SITE}/autopilot/pending`, body: {} });
    expect(calls[0]?.headers[RECORDER_HEADER]).toBe(KEY);
    expect(calls[0]?.headers.authorization).toBeUndefined();
  });

  it('throws when what is waiting could not be read, so a round is skipped and not taken as empty', async () => {
    for (const answer of [
      () => json(403, { ok: false, code: 'forbidden' }),
      () => json(200, { ok: true }),
      () => {
        throw new Error('connect ECONNREFUSED');
      },
    ]) {
      await expect(setup(answer).recorder.autopilot.pending()).rejects.toThrow(/could not be read/);
    }
  });

  it("takes the lock for a proposal's order with the key and the proposal's id, and no token", async () => {
    const { recorder, calls } = setup(() => json(200, { ok: true, orderId: 'k17open' }));
    const mine = recorder.forProposal(PROPOSAL);
    expect(await mine.begin(order)).toEqual({ ok: true, orderId: 'k17open' });
    expect(calls[0]).toMatchObject({ url: `${SITE}/autopilot/begin`, body: { proposalId: PROPOSAL, ...order } });
    expect(calls[0]?.headers.authorization).toBeUndefined();
    expect(calls[0]?.headers[RECORDER_HEADER]).toBe(KEY);
    // Who the order is for is the proposal's to say. The body names nobody.
    expect(Object.keys(calls[0]?.body as object).sort()).toEqual(['action', 'asset', 'leverage', 'network', 'notionalUsd', 'proposalId', 'side']);
    // The order's own record goes where every order's does.
    await mine.settle({ orderId: 'k17open', status: 'filled' });
    expect(calls[1]?.url).toBe(`${SITE}/venue/settle`);
  });

  it('sends nothing for a proposal the backend will not open, and waits on a lock that is taken', async () => {
    const refused = setup(() => json(200, { ok: false, code: 'not_pending' }));
    // Read as an order that could not be recorded: the order service then sends nothing.
    expect(await refused.recorder.forProposal(PROPOSAL).begin(order)).toEqual({ ok: false, code: 'unreachable' });
    expect(refused.logs).toEqual([{ level: 'error', event: 'recorder_refused', path: '/autopilot/begin', status: 200, code: 'not_pending' }]);

    const busy = setup(() => json(200, { ok: false, code: 'busy' }));
    expect(await busy.recorder.forProposal(PROPOSAL).begin(order)).toEqual({ ok: false, code: 'busy' });
  });

  it('writes a trade that has opened in the name of its proposal, with no token', async () => {
    const { recorder, calls } = setup(() => json(200, { ok: true, tradeId: 'k27timed' }));
    expect(await recorder.timed.start({ proposalId: PROPOSAL }, trade)).toBe('k27timed');
    expect(calls[0]).toMatchObject({ url: `${SITE}/autopilot/start`, body: { proposalId: PROPOSAL, ...trade } });
    expect(calls[0]?.headers.authorization).toBeUndefined();
    expect(Object.keys(calls[0]?.body as object)).not.toContain('userId');
  });

  it('answers null when that trade could not be written, so the position is taken back', async () => {
    for (const answer of [() => json(200, { ok: false, code: 'not_pending' }), () => json(500, { ok: false, code: 'failed' }), () => { throw new Error('down'); }]) {
      expect(await setup(answer).recorder.timed.start({ proposalId: PROPOSAL }, trade)).toBeNull();
    }
  });

  it("never sends a person's trade to the proposal's route, or a proposal's to the person's", async () => {
    const { recorder, calls } = setup(() => json(200, { ok: true, tradeId: 'k27timed' }));
    await recorder.timed.start({ token: TOKEN }, trade);
    await recorder.timed.start({ proposalId: PROPOSAL }, trade);
    expect(calls.map((c) => [c.url, c.headers.authorization, 'proposalId' in (c.body as object)])).toEqual([
      [`${SITE}/timed/start`, `Bearer ${TOKEN}`, false],
      [`${SITE}/autopilot/start`, undefined, true],
    ]);
  });

  it('says what became of a proposal, and throws when that was not written', async () => {
    const opened = { proposalId: PROPOSAL, outcome: 'opened', timedTradeId: 'k27timed' } as const;
    const not = { proposalId: PROPOSAL, outcome: 'not_opened', reason: 'The BTC market is closed.' } as const;
    const { recorder, calls } = setup(() => json(200, { ok: true }));
    await recorder.autopilot.report(opened);
    await recorder.autopilot.report(not);
    expect(calls.map((c) => [c.url, c.body])).toEqual([
      [`${SITE}/autopilot/report`, opened],
      [`${SITE}/autopilot/report`, not],
    ]);
    expect(calls[0]?.headers.authorization).toBeUndefined();
    for (const answer of [() => json(500, { ok: false, code: 'failed' }), () => json(200, { ok: false, code: 'not_found' })]) {
      await expect(setup(answer).recorder.autopilot.report(not)).rejects.toThrow(/k57proposal could not be written/);
    }
  });
});
