import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { marginAccountAbi } from './abi';

interface JsonAbiItem {
  type: string;
  name?: string;
  stateMutability?: string;
  inputs?: { type: string }[];
  outputs?: { type: string }[];
}

const contract: JsonAbiItem[] = JSON.parse(
  readFileSync(new URL('../../contracts/abi/MarginAccount.json', import.meta.url), 'utf8'),
);

const sig = (i: { name?: string; inputs?: readonly { type: string }[] }) =>
  `${i.name}(${(i.inputs ?? []).map((x) => x.type).join(',')})`;

describe('marginAccountAbi', () => {
  it('matches packages/contracts/abi/MarginAccount.json entry for entry', () => {
    for (const item of marginAccountAbi) {
      const theirs = contract.find((c) => c.type === item.type && c.name === item.name);
      expect(theirs, `${item.type} ${item.name} missing from the contract ABI`).toBeDefined();
      expect(sig(theirs!)).toBe(sig(item));
      if (item.type === 'function') {
        expect(theirs!.stateMutability).toBe(item.stateMutability);
        const outs = (x: { outputs?: readonly { type: string }[] }) => (x.outputs ?? []).map((o) => o.type).join(',');
        expect(outs(theirs!)).toBe(outs(item as unknown as { outputs?: readonly { type: string }[] }));
      }
    }
  });
});
