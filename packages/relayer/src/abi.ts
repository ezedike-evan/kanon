import { parseAbi } from 'viem';

/**
 * The slice of Pyth's `IPyth` the relayer calls. `packages/contracts/src/pyth/IPyth.sol`
 * only declares the read side (`getPriceNoOlderThan`), because the contracts
 * never push prices; the relayer does, so the write side is declared here.
 * Signatures match https://github.com/pyth-network/pyth-sdk-solidity/blob/main/IPyth.sol.
 */
export const pythAbi = parseAbi([
  'function getUpdateFee(bytes[] updateData) view returns (uint256 feeAmount)',
  'function updatePriceFeeds(bytes[] updateData) payable',
]);

/**
 * `CanonicalSeries.recordSample()` takes no arguments and is not payable. It
 * pulls the price already stored in Pyth (`getPriceNoOlderThan`), which is why
 * the update must land in Pyth first.
 */
export const canonicalSeriesAbi = parseAbi([
  'function feedId() view returns (bytes32)',
  'function cadenceSeconds() view returns (uint256)',
  'function lastSampleTimestamp() view returns (uint256)',
  'function recordSample()',
]);
