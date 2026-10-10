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
