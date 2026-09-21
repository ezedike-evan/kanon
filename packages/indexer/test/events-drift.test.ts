import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { decodeBytes32Text, scopedId } from "../src/lib/helpers";

/**
 * Guards against the indexer silently going stale: every event the Solidity
 * sources declare must be indexed in config.yaml with the identical signature,
 * and every configured event must still exist in the contracts. The contracts
 * are still evolving; a new or changed event fails here instead of vanishing
 * from the indexed history.
 *
 * If an event is deliberately not indexed, add it to IGNORED below with a reason.
 */

const here = dirname(fileURLToPath(import.meta.url));
const contractsSrc = resolve(here, "../../contracts/src");
const config = readFileSync(resolve(here, "../config.yaml"), "utf8");

const IGNORED: Record<string, readonly string[]> = {};

const normalize = (sig: string): string =>
  sig
    .replace(/\s+/g, " ")
    .replace(/\s*\(\s*/g, "(")
    .replace(/\s*\)\s*/g, ")")
    .replace(/\s*,\s*/g, ", ")
    .trim();

function configEvents(): Record<string, string[]> {
  const top = config.slice(0, config.indexOf("\nchains:"));
  const out: Record<string, string[]> = {};
  let current: string | null = null;
  for (const line of top.split("\n")) {
    const name = /^\s*-\s*name:\s*(\w+)\s*$/.exec(line);
    if (name) {
      current = name[1]!;
      out[current] = [];
      continue;
    }
    const ev = /^\s*-\s*event:\s*"([^"]+)"\s*$/.exec(line);
    if (ev && current) out[current]!.push(normalize(ev[1]!));
  }
  return out;
}

function solidityEvents(file: string): string[] {
  const src = readFileSync(file, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  const found: string[] = [];
  for (const m of src.matchAll(/\bevent\s+(\w+)\s*\(([^)]*)\)\s*;/g)) {
    found.push(normalize(`${m[1]}(${m[2]})`));
  }
  return found;
}

describe.skipIf(!existsSync(contractsSrc))("config.yaml matches the Solidity events", () => {
  const cfg = configEvents();
  for (const [contract, signatures] of Object.entries(cfg)) {
    const file = resolve(contractsSrc, `${contract}.sol`);
    it(`${contract}`, () => {
      expect(existsSync(file), `${file} exists`).toBe(true);
      const ignored = new Set(IGNORED[contract] ?? []);
      const declared = solidityEvents(file).filter((s) => !ignored.has(s.slice(0, s.indexOf("("))));
      expect([...signatures].sort()).toEqual([...declared].sort());
    });
  }
});

// Second source of truth: the ABI JSON another package exports, when present.
const abiDir = resolve(here, "../../contracts/abi");
describe.skipIf(!existsSync(abiDir))("config.yaml matches packages/contracts/abi", () => {
  const cfg = configEvents();
  for (const [contract, signatures] of Object.entries(cfg)) {
    const file = resolve(abiDir, `${contract}.json`);
    it.skipIf(!existsSync(file))(`${contract}`, () => {
      const raw = JSON.parse(readFileSync(file, "utf8")) as unknown;
      const abi = (Array.isArray(raw) ? raw : (raw as { abi: unknown[] }).abi) as Array<{
        type: string;
        name?: string;
        inputs?: Array<{ type: string; name: string; indexed?: boolean }>;
      }>;
      const fromAbi = abi
        .filter((e) => e.type === "event")
        .map((e) => normalize(`${e.name}(${(e.inputs ?? []).map((i) => `${i.type}${i.indexed ? " indexed" : ""} ${i.name}`).join(", ")})`));
      expect([...signatures].sort()).toEqual(fromAbi.sort());
    });
  }
});

describe("helpers", () => {
  it("decodes right-padded bytes32 labels and leaves non-text as hex", () => {
    expect(decodeBytes32Text(`0x${Buffer.from("bos_long").toString("hex").padEnd(64, "0")}`)).toBe("bos_long");
    expect(decodeBytes32Text(`0x${"00".repeat(32)}`)).toBe("");
    const binary = `0x${"ab".repeat(32)}`;
    expect(decodeBytes32Text(binary)).toBe(binary);
    expect(decodeBytes32Text("not-hex")).toBe("not-hex");
  });

  it("scopes ids by chain", () => {
    expect(scopedId(143, "0xabc", 7n, 2)).toBe("143_0xabc_7_2");
  });
});
