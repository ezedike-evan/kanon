import { describe, expect, it } from "vitest";
import {
  GATE_DEFAULTS,
  SIGNER_DEFAULTS,
  describeEnvProblem,
  parseChainEnv,
  parseCompilerEnv,
  parseDashscopeEnv,
  parseGateEnv,
  parseKeeperSwitch,
  parseNansenEnv,
  parseRegistryEnv,
  parseSeriesEnv,
  parseSignerEnv,
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
  it("passes the host's thinking switch through, and nothing else", () => {
    expect(
      parseCompilerEnv({
        COMPILER_API_KEY: "sk-moonshot1",
        COMPILER_BASE_URL: "https://api.moonshot.ai/v1",
        COMPILER_MODEL: "kimi-k2.6",
        COMPILER_THINKING: "disabled",
      }),
    ).toEqual({
      ok: true,
      value: { apiKey: "sk-moonshot1", baseUrl: "https://api.moonshot.ai/v1", model: "kimi-k2.6", thinking: "disabled" },
    });
    expect(
      parseCompilerEnv({ COMPILER_API_KEY: "sk-moonshot1", COMPILER_BASE_URL: "https://api.moonshot.ai/v1", COMPILER_THINKING: "off" }),
    ).toEqual({ ok: false, invalid: ["COMPILER_THINKING"] });
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

describe("parseSignerEnv", () => {
  // A made-up key for the test. It is checked below never to appear in a report.
  const KEY = "0x" + "7a".repeat(32);

  it("needs the key, and names it without echoing it", () => {
    expect(parseSignerEnv({})).toEqual({ ok: false, invalid: ["KEEPER_PRIVATE_KEY"] });
    const short = "0x" + "7a".repeat(31);
    const r = parseSignerEnv({ KEEPER_PRIVATE_KEY: short });
    expect(r).toEqual({ ok: false, invalid: ["KEEPER_PRIVATE_KEY"] });
    expect(JSON.stringify(r)).not.toContain("7a7a");
    expect(describeEnvProblem("keeper:tick", r.ok ? [] : r.invalid)).not.toContain("7a7a");
  });

  it("never echoes the key when another variable is what is wrong", () => {
    const r = parseSignerEnv({ KEEPER_PRIVATE_KEY: KEY, KEEPER_MAX_FEE_GWEI: "lots" });
    expect(r).toEqual({ ok: false, invalid: ["KEEPER_MAX_FEE_GWEI"] });
    expect(JSON.stringify(r)).not.toContain(KEY.slice(2, 12));
  });

  it("defaults every amount, as the env table says", () => {
    expect(parseSignerEnv({ KEEPER_PRIVATE_KEY: KEY })).toEqual({
      ok: true,
      value: {
        privateKey: KEY,
        minBalanceWei: 200_000_000_000_000_000n,
        warnBalanceWei: 1_000_000_000_000_000_000n,
        maxFeePerGasWei: 250_000_000_000n,
        dailySpendWei: 4_000_000_000_000_000_000n,
        keeperReserveWei: 2_500_000_000_000_000_000n,
      },
    });
    expect(SIGNER_DEFAULTS.minBalanceWei).toBe(2n * 10n ** 17n);
  });

  it("reads MON and gwei exactly into wei, with no float on the way", () => {
    const r = parseSignerEnv({
      KEEPER_PRIVATE_KEY: KEY,
      KEEPER_MIN_BALANCE_MON: "0.1",
      KEEPER_WARN_BALANCE_MON: "1.000000000000000001",
      KEEPER_MAX_FEE_GWEI: "102.5",
      SIGNER_DAILY_SPEND_MON: "0.3",
      KEEPER_RESERVE_MON: "0.25",
    });
    expect(r.ok && r.value).toMatchObject({
      minBalanceWei: 100_000_000_000_000_000n,
      warnBalanceWei: 1_000_000_000_000_000_001n,
      maxFeePerGasWei: 102_500_000_000n,
      // 0.1 + 0.2 is not 0.3 in floats; in wei it is.
      dailySpendWei: 300_000_000_000_000_000n,
      keeperReserveWei: 250_000_000_000_000_000n,
    });
  });

  it("refuses an amount it would have to round, a negative one, or a word", () => {
    for (const bad of ["0.0000000000000000001", "-1", "1e18", "four", "1,000"]) {
      expect(parseSignerEnv({ KEEPER_PRIVATE_KEY: KEY, SIGNER_DAILY_SPEND_MON: bad })).toEqual({
        ok: false,
        invalid: ["SIGNER_DAILY_SPEND_MON"],
      });
    }
    expect(parseSignerEnv({ KEEPER_PRIVATE_KEY: KEY, KEEPER_MAX_FEE_GWEI: "0.0000000001" })).toEqual({
      ok: false,
      invalid: ["KEEPER_MAX_FEE_GWEI"],
    });
  });

  it("treats a blank amount as unset", () => {
    expect(parseSignerEnv({ KEEPER_PRIVATE_KEY: KEY, KEEPER_MIN_BALANCE_MON: " " }).ok).toBe(true);
  });
});

describe("parseGateEnv", () => {
  const gate = {
    STRATEGY_REGISTRY_ADDRESS: "0xDB91f547B59A3326f3DB8E8F510E8dbbf4e50852",
    STRATEGY_REGISTRY_RPC_URL: "https://testnet.example/secret-key",
    STRATEGY_REGISTRY_CHAIN_ID: "10143",
    MONAD_RPC_URL: "https://mainnet.example/other-secret",
    REFUSAL_GATE_ADDRESS: "0x388f55962954c5083D885543aF22b1b6EE640ec0",
    MOCK_PYTH_ADDRESS: "0x7B0564b87Edd57d7BB70550b1FBA3384964862ce",
    SERIES_BTCUSD_ADDRESS: "0x74c4b8710Fb83Dcc18c1A5ae2E35A63dc005257a",
  };

  it("takes the registry's chain, lower-cases every address, and defaults the limits", () => {
    expect(parseGateEnv(gate)).toEqual({
      ok: true,
      value: {
        rpcUrl: gate.STRATEGY_REGISTRY_RPC_URL,
        chainId: 10143,
        registryAddress: gate.STRATEGY_REGISTRY_ADDRESS.toLowerCase(),
        gateAddress: gate.REFUSAL_GATE_ADDRESS.toLowerCase(),
        mockPythAddress: gate.MOCK_PYTH_ADDRESS.toLowerCase(),
        series: { "BTC/USD": gate.SERIES_BTCUSD_ADDRESS.toLowerCase() },
        sourceRpcUrl: gate.MONAD_RPC_URL,
        keeperMaxGas: 400_000n,
        gateMaxGas: 2_000_000n,
        maxSourceAgeSeconds: 7_200n,
      },
    });
    expect(GATE_DEFAULTS.keeperMaxGas).toBe(400_000n);
  });

  it("reads mainnet Pyth from the public RPC when MONAD_RPC_URL is unset", () => {
    const { MONAD_RPC_URL: _unset, ...rest } = gate;
    const r = parseGateEnv(rest);
    expect(r.ok && r.value.sourceRpcUrl).toBe("https://rpc.monad.xyz");
  });

  it("names every fault at once, its own and the registry's, and echoes none of them", () => {
    const r = parseGateEnv({
      ...gate,
      STRATEGY_REGISTRY_CHAIN_ID: undefined,
      MONAD_CHAIN_ID: undefined,
      REFUSAL_GATE_ADDRESS: "0x12",
      MOCK_PYTH_ADDRESS: undefined,
      SERIES_ETHUSD_ADDRESS: "0xnope",
      KEEPER_MAX_GAS: "0",
      GATE_MAX_GAS: "2e6",
      KEEPER_MAX_SOURCE_AGE_SECONDS: "-5",
    });
    expect(r.ok).toBe(false);
    expect(r.ok ? [] : [...r.invalid].sort()).toEqual(
      [
        "STRATEGY_REGISTRY_CHAIN_ID",
        "SERIES_ETHUSD_ADDRESS",
        "REFUSAL_GATE_ADDRESS",
        "MOCK_PYTH_ADDRESS",
        "KEEPER_MAX_GAS",
        "GATE_MAX_GAS",
        "KEEPER_MAX_SOURCE_AGE_SECONDS",
      ].sort(),
    );
    expect(JSON.stringify(r)).not.toMatch(/secret|nope|0x12/);
  });

  it("serves a pair only when its series is named", () => {
    expect(parseSeriesEnv({})).toEqual({ ok: true, value: {} });
    expect(parseSeriesEnv({ SERIES_ETHUSD_ADDRESS: "0x8D2D1b9DAfA8f68ECcfEC9FDEbbe04268b4ffbf3" })).toEqual({
      ok: true,
      value: { "ETH/USD": "0x8d2d1b9dafa8f68eccfec9fdebbe04268b4ffbf3" },
    });
  });
});

describe("parseKeeperSwitch", () => {
  it("is off unless it says on, so a deploy alone spends nothing", () => {
    expect(parseKeeperSwitch({})).toEqual({ ok: true, value: false });
    expect(parseKeeperSwitch({ KEEPER_ENABLED: "off" })).toEqual({ ok: true, value: false });
    expect(parseKeeperSwitch({ KEEPER_ENABLED: " on " })).toEqual({ ok: true, value: true });
  });
  it("calls anything else a fault, which sends nothing either", () => {
    expect(parseKeeperSwitch({ KEEPER_ENABLED: "true" })).toEqual({ ok: false, invalid: ["KEEPER_ENABLED"] });
  });
});
