import { describe, expect, it } from "vitest";
import { describeEnvProblem, parseChainEnv, parseDashscopeEnv, parseNansenEnv } from "./serverEnv";

const good = {
  MONAD_RPC_URL: "https://rpc.example/secret-key",
  MONAD_CHAIN_ID: "10143",
  THRESHOLD_MARKET_ADDRESS: "0x" + "Ab".repeat(20),
  VAULT_FACTORY_ADDRESS: "0x" + "cD".repeat(20),
};

describe("parseChainEnv", () => {
  it("fails closed when nothing is set", () => {
    const r = parseChainEnv({}, ["market"]);
    expect(r).toEqual({ ok: false, invalid: ["MONAD_RPC_URL", "MONAD_CHAIN_ID", "THRESHOLD_MARKET_ADDRESS"] });
  });
  it("parses and lower-cases addresses", () => {
    const r = parseChainEnv(good, ["market", "factory"]);
    expect(r.ok && r.value).toMatchObject({ chainId: 10143, marketAddress: "0x" + "ab".repeat(20), factoryAddress: "0x" + "cd".repeat(20) });
  });
  it("needs an address only when asked for it", () => {
    expect(parseChainEnv({ MONAD_RPC_URL: good.MONAD_RPC_URL, MONAD_CHAIN_ID: "143" }, []).ok).toBe(true);
    expect(parseChainEnv({ MONAD_RPC_URL: good.MONAD_RPC_URL, MONAD_CHAIN_ID: "143" }, ["factory"]).ok).toBe(false);
  });
  it("rejects a bad chain id, URL and address", () => {
    const r = parseChainEnv({ ...good, MONAD_CHAIN_ID: "0x8f", MONAD_RPC_URL: "ftp://x", THRESHOLD_MARKET_ADDRESS: "0x12" }, ["market"]);
    expect(r).toEqual({ ok: false, invalid: ["MONAD_RPC_URL", "MONAD_CHAIN_ID", "THRESHOLD_MARKET_ADDRESS"] });
  });
  it("treats a blank variable as unset", () => {
    expect(parseChainEnv({ ...good, MONAD_RPC_URL: "  " }, []).ok).toBe(false);
  });
  it("never echoes a value in its report", () => {
    const r = parseChainEnv({ ...good, MONAD_CHAIN_ID: "secret-ish" }, []);
    expect(JSON.stringify(r)).not.toContain("secret");
  });
});

describe("other keys", () => {
  it("requires a DashScope key", () => {
    expect(parseDashscopeEnv({})).toEqual({ ok: false, invalid: ["DASHSCOPE_API_KEY"] });
    expect(parseDashscopeEnv({ DASHSCOPE_API_KEY: "sk-12345678" })).toEqual({ ok: true, value: { apiKey: "sk-12345678" } });
  });
  it("Nansen unset is fine, a bad base URL is not", () => {
    expect(parseNansenEnv({})).toEqual({ ok: true, value: { apiKey: undefined, baseUrl: undefined } });
    expect(parseNansenEnv({ NANSEN_API_KEY: "abcdefgh", NANSEN_BASE_URL: "nope" })).toEqual({ ok: false, invalid: ["NANSEN_BASE_URL"] });
  });
  it("describes a problem by name only", () => {
    expect(describeEnvProblem("x", ["A", "B"])).toContain("A, B");
  });
});
