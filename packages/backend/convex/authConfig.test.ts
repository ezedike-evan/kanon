import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const load = async () => (await import("./auth.config")).default;

describe("auth.config (Privy custom JWT)", () => {
  const original = process.env.PRIVY_APP_ID;
  beforeEach(() => vi.resetModules());
  afterEach(() => {
    if (original === undefined) delete process.env.PRIVY_APP_ID;
    else process.env.PRIVY_APP_ID = original;
  });

  it("verifies ES256 tokens against the app's own JWKS, for this app's audience only", async () => {
    process.env.PRIVY_APP_ID = "clx123abc";
    const config = await load();
    expect(config.providers).toEqual([
      {
        type: "customJwt",
        applicationID: "clx123abc",
        issuer: "privy.io",
        jwks: "https://auth.privy.io/api/v1/apps/clx123abc/jwks.json",
        algorithm: "ES256",
      },
    ]);
  });

  it("takes the app id from the environment, never the source", async () => {
    process.env.PRIVY_APP_ID = "  other-app  ";
    const [provider] = (await load()).providers;
    expect(provider?.applicationID).toBe("other-app");
    expect(provider?.jwks).toContain("/apps/other-app/");
  });

  it.each([undefined, "", "   "])("refuses to load with PRIVY_APP_ID = %j (no fallback)", async (value) => {
    if (value === undefined) delete process.env.PRIVY_APP_ID;
    else process.env.PRIVY_APP_ID = value;
    await expect(load()).rejects.toThrow(/PRIVY_APP_ID/);
  });
});
