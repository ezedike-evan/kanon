import { describe, expect, it, vi } from "vitest";
import { RpcError, rpcRequest, type FetchLike, type RpcConfig } from "./chainRpc";

const ok = (result: unknown) => ({ ok: true, status: 200, json: async () => ({ jsonrpc: "2.0", id: 1, result }) });
const cfg = (fetch: FetchLike, extra: Partial<RpcConfig> = {}): RpcConfig => ({
  url: "http://rpc.test",
  fetch,
  sleep: async () => undefined,
  ...extra,
});

describe("rpcRequest", () => {
  it("returns the result", async () => {
    const f = vi.fn(async () => ok("0x1"));
    expect(await rpcRequest(cfg(f), "eth_chainId", [])).toBe("0x1");
    expect(f).toHaveBeenCalledTimes(1);
  });

  it("retries a network fault then succeeds", async () => {
    const f = vi.fn<FetchLike>().mockRejectedValueOnce(new Error("boom")).mockResolvedValueOnce(ok("0x2"));
    expect(await rpcRequest(cfg(f), "m", [])).toBe("0x2");
    expect(f).toHaveBeenCalledTimes(2);
  });

  it("retries a 5xx and gives up after the configured attempts", async () => {
    const f = vi.fn(async () => ({ ok: false, status: 503, json: async () => ({}) }));
    await expect(rpcRequest(cfg(f, { retries: 2 }), "m", [])).rejects.toMatchObject({ kind: "http" });
    expect(f).toHaveBeenCalledTimes(3);
  });

  it("does not retry a JSON-RPC error: it is an answer", async () => {
    const f = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ error: { message: "execution reverted" } }) }));
    await expect(rpcRequest(cfg(f), "eth_call", [])).rejects.toMatchObject({ kind: "rpc" });
    expect(f).toHaveBeenCalledTimes(1);
  });

  it("times out a hung request, retries, then reports a timeout", async () => {
    const f: FetchLike = (_url, init) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => reject(new Error("aborted")));
      });
    const p = rpcRequest(cfg(f, { timeoutMs: 10, retries: 1 }), "m", []);
    await expect(p).rejects.toBeInstanceOf(RpcError);
    await expect(rpcRequest(cfg(f, { timeoutMs: 10, retries: 0 }), "m", [])).rejects.toMatchObject({ kind: "timeout" });
  });

  it("refuses a malformed body without retrying", async () => {
    const f = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({}) }));
    await expect(rpcRequest(cfg(f), "m", [])).rejects.toMatchObject({ kind: "malformed" });
    expect(f).toHaveBeenCalledTimes(1);
  });
});
