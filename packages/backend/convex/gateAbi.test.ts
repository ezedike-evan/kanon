import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { gateAbi, mockPythAbi, seriesAbi, seriesExpoAbi } from "./gatePort";

/**
 * The ABI fragments the backend sends with, held line by line to the ABIs the
 * contracts package exports from its build (`packages/contracts/abi/*.json`).
 * A contract change that moves a signature, an output, an indexed flag or an
 * error fails here, not in a live judgment.
 */

interface Param {
  type: string;
  name?: string;
  indexed?: boolean;
  components?: readonly Param[];
}
interface Item {
  type: string;
  name?: string;
  inputs?: readonly Param[];
  outputs?: readonly Param[];
  stateMutability?: string;
}

const built = (name: string): Item[] =>
  JSON.parse(readFileSync(resolve(__dirname, `../../contracts/abi/${name}.json`), "utf8")) as Item[];

/** A parameter as the chain hashes it: tuples spelled out, enums already `uint8` in the build. */
const canonical = (p: Param): string =>
  p.type.startsWith("tuple") ? `(${(p.components ?? []).map(canonical).join(",")})${p.type.slice("tuple".length)}` : p.type;

const shape = (x: Item) => ({
  type: x.type,
  name: x.name,
  inputs: (x.inputs ?? []).map((p) => canonical(p) + (p.indexed ? " indexed" : "")),
  ...(x.type === "function" ? { outputs: (x.outputs ?? []).map(canonical), stateMutability: x.stateMutability } : {}),
});

function expectAllIn(ours: readonly Item[], contract: string) {
  const theirs = built(contract);
  for (const item of ours) {
    if (item.type === "struct" || !item.name) continue;
    const match = theirs.find((t) => t.type === item.type && t.name === item.name);
    expect(match, `${contract} has no ${item.type} ${item.name}`).toBeDefined();
    expect(shape(item), `${contract}.${item.name}`).toEqual(shape(match!));
  }
}

describe("the ABIs the backend sends with", () => {
  it("match RefusalGate's build: both calls, both events, every error", () => {
    expectAllIn(gateAbi as readonly Item[], "RefusalGate");
    // Every error the gate can revert with decodes to its name, so a revert is never an unnamed one.
    const ours = new Set<string>(gateAbi.filter((x) => x.type === "error").map((x) => x.name));
    const theirs = built("RefusalGate").filter((x) => x.type === "error").map((x) => x.name);
    expect(theirs.filter((name) => !ours.has(name!))).toEqual([]);
  });

  it("match CanonicalSeries' build", () => {
    expectAllIn(seriesAbi as readonly Item[], "CanonicalSeries");
    expectAllIn(seriesExpoAbi as readonly Item[], "CanonicalSeries");
  });

  it("send setPrice in the shape the mock takes", () => {
    // MockPyth is a test contract with no build in abi/: its one call is pinned here by hand.
    expect(shape(mockPythAbi[0] as Item)).toEqual({
      type: "function",
      name: "setPrice",
      inputs: ["bytes32", "int64", "uint64", "int32", "uint256"],
      outputs: [],
      stateMutability: "nonpayable",
    });
  });
});
