/**
 * A plain-`fetch` JSON-RPC client with a timeout and a small retry. No
 * dependency, so it runs in Convex's default runtime. Transport faults
 * (network error, timeout, 429, 5xx) are retried; a JSON-RPC `error` is an
 * answer and is not.
 */

export type FetchLike = (
  url: string,
  init: { method: "POST"; headers: Record<string, string>; body: string; signal?: AbortSignal },
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

export interface RpcConfig {
  url: string;
  fetch: FetchLike;
  timeoutMs?: number;
  /** Extra attempts after the first. */
  retries?: number;
  /** Delay before retry n (0-based). Injectable so tests do not sleep. */
  backoffMs?: (attempt: number) => number;
  sleep?: (ms: number) => Promise<void>;
}

export class RpcError extends Error {
  constructor(
    readonly kind: "timeout" | "network" | "http" | "rpc" | "malformed",
    message: string,
  ) {
    super(message);
    this.name = "RpcError";
  }
}

export const DEFAULT_RPC_TIMEOUT_MS = 8_000;
export const DEFAULT_RPC_RETRIES = 2;

const retryable = (e: RpcError) => e.kind === "timeout" || e.kind === "network" || e.kind === "http";

async function once(cfg: RpcConfig, body: string): Promise<unknown> {
  const controller = new AbortController();
  const timeoutMs = cfg.timeoutMs ?? DEFAULT_RPC_TIMEOUT_MS;
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  try {
    const res = await cfg.fetch(cfg.url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
      signal: controller.signal,
    });
    if (!res.ok) throw new RpcError("http", `RPC responded ${res.status}`);
    return await res.json();
  } catch (err) {
    if (err instanceof RpcError) throw err;
    if (timedOut) throw new RpcError("timeout", `RPC did not answer within ${timeoutMs}ms`);
    throw new RpcError("network", "RPC request failed");
  } finally {
    clearTimeout(timer);
  }
}

let nextId = 1;

export async function rpcRequest<T>(cfg: RpcConfig, method: string, params: unknown[]): Promise<T> {
  const body = JSON.stringify({ jsonrpc: "2.0", id: nextId++, method, params });
  const retries = cfg.retries ?? DEFAULT_RPC_RETRIES;
  const sleep = cfg.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  let last: RpcError | undefined;
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) await sleep(cfg.backoffMs ? cfg.backoffMs(attempt - 1) : 250 * 2 ** (attempt - 1));
    try {
      const json = (await once(cfg, body)) as { result?: unknown; error?: { message?: string } } | null;
      if (!json || typeof json !== "object") throw new RpcError("malformed", "RPC returned a non-object");
      if (json.error) throw new RpcError("rpc", `RPC error: ${String(json.error.message ?? "unknown")}`);
      if (!("result" in json)) throw new RpcError("malformed", "RPC returned no result");
      return json.result as T;
    } catch (err) {
      const e = err instanceof RpcError ? err : new RpcError("network", "RPC request failed");
      if (!retryable(e)) throw e;
      last = e;
    }
  }
  throw last ?? new RpcError("network", "RPC request failed");
}
