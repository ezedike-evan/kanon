import { describe, expect, it } from "vitest";
import {
  describeEnvProblem,
  parseChainEnv,
  parseCompilerEnv,
  parseDashscopeEnv,
  parseNansenEnv,
  parseRegistryEnv,
  parseVenueRecorderEnv,
} from "./serverEnv";

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

describe("parseRegistryEnv", () => {
  const REGISTRY = "0x" + "Ef".repeat(20);
  const own = {
    STRATEGY_REGISTRY_ADDRESS: REGISTRY,
    STRATEGY_REGISTRY_RPC_URL: "https://testnet.example/key",
    STRATEGY_REGISTRY_CHAIN_ID: "10143",
  };

  it("fails closed when nothing is set, and names what to set", () => {
    expect(parseRegistryEnv({})).toEqual({ ok: false, invalid: ["STRATEGY_REGISTRY_ADDRESS"] });
    expect(parseRegistryEnv({ STRATEGY_REGISTRY_ADDRESS: REGISTRY })).toEqual({
      ok: false,
      invalid: ["STRATEGY_REGISTRY_RPC_URL", "STRATEGY_REGISTRY_CHAIN_ID"],
    });
  });
  it("reads the registry's own chain, and lower-cases its address", () => {
    expect(parseRegistryEnv({ ...own, MONAD_RPC_URL: "https://rpc.monad.xyz", MONAD_CHAIN_ID: "143" })).toEqual({
      ok: true,
      value: { rpcUrl: own.STRATEGY_REGISTRY_RPC_URL, chainId: 10143, registryAddress: "0x" + "ef".repeat(20) },
    });
  });
  it("falls back to the deployment's chain only as a pair", () => {
    expect(parseRegistryEnv({ STRATEGY_REGISTRY_ADDRESS: REGISTRY, MONAD_RPC_URL: good.MONAD_RPC_URL, MONAD_CHAIN_ID: "143" })).toEqual({
      ok: true,
      value: { rpcUrl: good.MONAD_RPC_URL, chainId: 143, registryAddress: "0x" + "ef".repeat(20) },
    });
    expect(parseRegistryEnv({ STRATEGY_REGISTRY_ADDRESS: REGISTRY, MONAD_RPC_URL: good.MONAD_RPC_URL })).toEqual({
      ok: false,
      invalid: ["STRATEGY_REGISTRY_CHAIN_ID"],
    });
  });
  it("never pairs one chain's RPC with the other's id", () => {
    const { STRATEGY_REGISTRY_CHAIN_ID: _id, ...noId } = own;
    expect(parseRegistryEnv({ ...noId, MONAD_RPC_URL: "https://rpc.monad.xyz", MONAD_CHAIN_ID: "143" })).toEqual({
      ok: false,
      invalid: ["STRATEGY_REGISTRY_CHAIN_ID"],
    });
    const { STRATEGY_REGISTRY_RPC_URL: _url, ...noUrl } = own;
    expect(parseRegistryEnv({ ...noUrl, MONAD_RPC_URL: "https://rpc.monad.xyz", MONAD_CHAIN_ID: "143" })).toEqual({
      ok: false,
      invalid: ["STRATEGY_REGISTRY_RPC_URL"],
    });
  });
  it("rejects a malformed address without echoing it", () => {
    const r = parseRegistryEnv({ ...own, STRATEGY_REGISTRY_ADDRESS: "0x12" });
    expect(r).toEqual({ ok: false, invalid: ["STRATEGY_REGISTRY_ADDRESS"] });
  });
});

describe("other keys", () => {
  it("requires a DashScope key", () => {
    expect(parseDashscopeEnv({})).toEqual({ ok: false, invalid: ["DASHSCOPE_API_KEY"] });
    expect(parseDashscopeEnv({ DASHSCOPE_API_KEY: "sk-12345678" })).toEqual({ ok: true, value: { apiKey: "sk-12345678" } });
  });
  it("sends the compiler to DashScope with its own key unless another host is named", () => {
    expect(parseCompilerEnv({})).toEqual({ ok: false, invalid: ["DASHSCOPE_API_KEY"] });
    expect(parseCompilerEnv({ DASHSCOPE_API_KEY: "sk-12345678" })).toEqual({
      ok: true,
      value: { apiKey: "sk-12345678", baseUrl: undefined, model: undefined },
    });
    expect(
      parseCompilerEnv({
        DASHSCOPE_API_KEY: "sk-12345678",
        COMPILER_API_KEY: "or-87654321",
        COMPILER_BASE_URL: "https://openrouter.ai/api/v1",
        COMPILER_MODEL: "qwen/qwen3.8-max-0902",
      }),
    ).toEqual({
      ok: true,
      value: { apiKey: "or-87654321", baseUrl: "https://openrouter.ai/api/v1", model: "qwen/qwen3.8-max-0902" },
    });
  });
  it("never sends one provider's key to the other's address", () => {
    // Another host named, but only the DashScope key in hand: a fault, not a silent reuse of that key.
    expect(parseCompilerEnv({ DASHSCOPE_API_KEY: "sk-12345678", COMPILER_BASE_URL: "https://openrouter.ai/api/v1" })).toEqual({
      ok: false,
      invalid: ["COMPILER_API_KEY"],
    });
    // A second key with nowhere of its own to go would otherwise be sent to DashScope.
    expect(parseCompilerEnv({ COMPILER_API_KEY: "or-87654321" })).toEqual({ ok: false, invalid: ["COMPILER_BASE_URL"] });
    expect(parseCompilerEnv({ COMPILER_API_KEY: "or-87654321", COMPILER_BASE_URL: "nope" })).toEqual({
      ok: false,
      invalid: ["COMPILER_BASE_URL"],
    });
  });
  it("Nansen unset is fine, a bad base URL is not", () => {
    expect(parseNansenEnv({})).toEqual({ ok: true, value: { apiKey: undefined, baseUrl: undefined } });
    expect(parseNansenEnv({ NANSEN_API_KEY: "abcdefgh", NANSEN_BASE_URL: "nope" })).toEqual({ ok: false, invalid: ["NANSEN_BASE_URL"] });
  });
  it("describes a problem by name only", () => {
    expect(describeEnvProblem("x", ["A", "B"])).toContain("A, B");
  });
});

describe("parseVenueRecorderEnv", () => {
  const key = "r".repeat(48);

  it("fails closed with nothing set, or with a key too short to be one", () => {
    expect(parseVenueRecorderEnv({})).toEqual({ ok: false, invalid: ["VENUE_RECORDER_KEY"] });
    expect(parseVenueRecorderEnv({ VENUE_RECORDER_KEY: "   " })).toEqual({ ok: false, invalid: ["VENUE_RECORDER_KEY"] });
    expect(parseVenueRecorderEnv({ VENUE_RECORDER_KEY: "short" })).toEqual({ ok: false, invalid: ["VENUE_RECORDER_KEY"] });
  });

  it("takes the key, trimmed", () => {
    expect(parseVenueRecorderEnv({ VENUE_RECORDER_KEY: ` ${key}\n` })).toEqual({ ok: true, value: { key } });
  });

  it("never puts a value in the report", () => {
    expect(JSON.stringify(parseVenueRecorderEnv({ VENUE_RECORDER_KEY: "short-secret" }))).not.toContain("short-secret");
  });
});
