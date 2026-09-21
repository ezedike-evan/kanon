import { parseAbi } from 'viem';

/**
 * The slice of `MarginAccount` the keeper touches. `abi.test.ts` checks every
 * entry against `packages/contracts/abi/MarginAccount.json`, so a contract
 * change that would break the keeper fails a test instead of a liquidation.
 *
 * The custom errors are declared so viem decodes a revert into its name
 * (`NotLiquidatable`, ...), which is how the keeper tells "someone got there
 * first" from a genuine failure.
 */
export const marginAccountAbi = parseAbi([
  'function healthFactor(address account) view returns (uint256)',
  'function adlHealthThreshold() view returns (uint256)',
  'function LIQUIDATION_THRESHOLD() view returns (uint256)',
  'function openPositionCount(address account) view returns (uint256)',
  'function positionCount(address account) view returns (uint256)',
  'function positionOf(address account, uint256 positionId) view returns (address seriesContract, bool isLong, uint256 size, uint256 entryPrice, bool open)',
  'function liquidate(address account, uint256 positionId)',
  'function deleverage(address account) returns (uint256 positionId, uint256 closedSize)',
  'event PositionOpened(address indexed account, uint256 indexed positionId, address indexed seriesContract, bool isLong, uint256 size, uint256 entryPrice)',
  'error NoRecentPrice()',
  'error NotLiquidatable()',
  'error NotDeleverageable()',
  'error NothingToDeleverage()',
  'error PositionNotOpen()',
  'error PositionNotFound()',
]);

/**
 * `CanonicalSeries.recordSample()` is permissionless and takes no arguments.
 * `MarginAccount` reads only the current bucket of a series, so when nobody has
 * sampled since the bucket rolled over, `healthFactor` reverts `NoRecentPrice`
 * and the keeper has to record a sample itself before it can act.
 */
export const canonicalSeriesAbi = parseAbi(['function recordSample()']);
