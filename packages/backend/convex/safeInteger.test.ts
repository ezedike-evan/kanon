import { describe, expect, it } from "vitest";
import { safeIntegerFromAtoms } from "./proposerLogic";

describe("safeIntegerFromAtoms", () => {
  it("converts an exact integer", () => {
    expect(safeIntegerFromAtoms("42")).toBe(42);
    expect(safeIntegerFromAtoms("-7")).toBe(-7);
    expect(safeIntegerFromAtoms("9007199254740991")).toBe(9007199254740991);
  });
  it("refuses a figure a double would round", () => {
    expect(() => safeIntegerFromAtoms("9007199254740993")).toThrow(RangeError);
    expect(() => safeIntegerFromAtoms("1e21")).toThrow(RangeError);
    expect(() => safeIntegerFromAtoms("12.5")).toThrow(RangeError);
    expect(() => safeIntegerFromAtoms("")).toThrow(RangeError);
  });
});
