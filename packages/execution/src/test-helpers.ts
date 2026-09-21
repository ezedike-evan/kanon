/**
 * Test doubles shared by the venue tests. Not exported from the package.
 * Nothing here talks to a network: `FakeWebSocket` is scripted by the test.
 */

type Listener = (event: unknown) => void;

export interface FakeSocketScript {
  /** Called for every JSON frame the client sends after it connects. */
  onFrame?: (socket: FakeWebSocket, frame: Record<string, unknown>) => void;
  /** Whether the socket opens by itself (default true). */
  autoOpen?: boolean;
}

export class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  static script: FakeSocketScript = {};
  static readonly OPEN = 1;

  readyState = 0;
  readonly sent: string[] = [];
  readonly frames: Array<Record<string, unknown>> = [];
  private readonly listeners = new Map<string, Set<Listener>>();

  constructor(readonly url: string) {
    FakeWebSocket.instances.push(this);
    if (FakeWebSocket.script.autoOpen !== false) {
      setTimeout(() => {
        this.readyState = 1;
        this.emit('open', {});
      }, 0);
    }
  }

  static reset(script: FakeSocketScript = {}): void {
    FakeWebSocket.instances = [];
    FakeWebSocket.script = script;
  }

  addEventListener(type: string, fn: Listener): void {
    let set = this.listeners.get(type);
    if (!set) this.listeners.set(type, (set = new Set()));
    set.add(fn);
  }

  removeEventListener(type: string, fn: Listener): void {
    this.listeners.get(type)?.delete(fn);
  }

  send(data: string): void {
    this.sent.push(data);
    const frame = JSON.parse(data) as Record<string, unknown>;
    this.frames.push(frame);
    FakeWebSocket.script.onFrame?.(this, frame);
  }

  close(code = 1000, reason = ''): void {
    this.readyState = 3;
    this.emit('close', { code, reason });
  }

  emit(type: string, event: unknown): void {
    for (const fn of this.listeners.get(type) ?? []) fn(event);
  }

  /** Delivers a frame from the "server". */
  serverSend(payload: unknown): void {
    this.emit('message', { data: JSON.stringify(payload) });
  }
}

export const FakeWS = FakeWebSocket as unknown as typeof WebSocket;

/** A `fetch` double that records calls and answers from a route table. */
export interface FetchCall {
  url: string;
  init: RequestInit | undefined;
}

export function fakeFetch(
  routes: (url: string, init: RequestInit | undefined) => { status?: number; body: unknown } | undefined,
): { fetchImpl: typeof fetch; calls: FetchCall[] } {
  const calls: FetchCall[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    const hit = routes(url, init);
    if (!hit) return new Response('not found', { status: 404 });
    const status = hit.status ?? 200;
    const text = typeof hit.body === 'string' ? hit.body : JSON.stringify(hit.body);
    return new Response(text, { status });
  }) as typeof fetch;
  return { fetchImpl, calls };
}

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
