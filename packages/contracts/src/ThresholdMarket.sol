// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import { ICanonicalSeries } from "./CanonicalSeries.sol";
import { PythStructs } from "./pyth/PythStructs.sol";
import { ReentrancyGuard } from "./ReentrancyGuard.sol";

/**
 * @title ThresholdMarket
 * @notice Settlement contract for the Predict tab: a binary market on whether a
 *         CanonicalSeries crosses a fixed threshold price during a fixed
 *         window. This is the first on-chain piece of the broader multi-asset
 *         trading terminal; margin, vault and copy-trading contracts are a
 *         later pass (see the TODO at the bottom of this file).
 *
 * @dev    Settlement reads ONLY recorded candles from the referenced
 *         CanonicalSeries, via `swingHigh`/`swingLow` over the window's bucket
 *         range. Per docs/ARCHITECTURE.md's central asymmetry, this contract
 *         never asserts anything about a tick nobody recorded. If the window
 *         has zero recorded candles, settlement marks the market unresolvable
 *         and every participant can reclaim their own stake — it never guesses
 *         a side.
 *
 *         Market semantics: `above` fixes the *question*, not a side.
 *           - `above == true`  — "did the recorded price reach at or above
 *             `thresholdPrice` during the window?" Resolves YES iff
 *             `swingHigh(window) >= thresholdPrice`.
 *           - `above == false` — "did the recorded price reach at or below
 *             `thresholdPrice` during the window?" Resolves YES iff
 *             `swingLow(window) <= thresholdPrice`.
 *         `takeSide(marketId, true)` stakes on YES (the configured condition
 *         happens); `takeSide(marketId, false)` stakes on NO.
 *
 *         `thresholdPrice` must be supplied in the referenced series' native
 *         fixed-point units (`CanonicalSeries.priceExpo`), the same units
 *         `swingHigh`/`swingLow` return. This contract does no unit conversion
 *         — mismatched expo is a caller error, not something this contract can
 *         detect on its own, since a series' `priceExpo` is only set after its
 *         first recorded sample.
 *
 *         EXACT WINDOW. Both `settle` and the crossing check use the series'
 *         `windowHigh/windowLow(windowStart, min(windowEnd, now))`, which look at
 *         each recorded sample's Pyth PUBLISH time, inclusive at both ends. A
 *         sample published before `windowStart` or after `windowEnd` never
 *         counts, even when it shares a bucket with the window edge, so nobody
 *         can flip an outcome by recording an out-of-window sample. A price
 *         published AT `windowStart` or `windowEnd` counts. Because a sample
 *         published at `t <= windowEnd` can still be recorded until
 *         `t + maxPriceAgeSeconds`, `settle` waits until
 *         `windowEnd + maxPriceAgeSeconds` has passed: after that no in-window
 *         sample can be added, so the tape is final and settling early cannot
 *         pre-empt a legitimate late recording.
 *
 *         NO STAKING ON INFORMATION ALREADY IN THE SERIES. The question is
 *         monotone: once a recorded sample inside the window has touched the
 *         threshold, YES is decided and nothing that happens later can undo
 *         it. So `takeSide` reverts `MarketCrossed` as soon as the series has
 *         RECORDED a sample in `[bucketIndexOf(windowStart),
 *         bucketIndexOf(min(windowEnd, now))]` whose high (`above`) or low
 *         (`!above`) satisfies the crossing condition — the exact condition
 *         `settle` uses, over the exact bucket range `settle` uses. That is the
 *         "already knowable" line; no separate `stakeDeadline` is needed
 *         because there is no ambiguity to resolve. (The NO side is only
 *         decided at `windowEnd`, which is when staking closes anyway; a NO
 *         that is merely very likely late in the window is market risk, not
 *         knowledge already in the series.)
 *
 *         FRESHNESS. A stale series could hide a crossing that the feed
 *         already shows. `takeSide` therefore requires the series' last sample
 *         to be at most one `cadenceSeconds` old. If it is older, `takeSide`
 *         itself calls the series' permissionless `recordSample()` (try/catch)
 *         and re-checks; if the tape is still stale — feed too old, or no
 *         price — it reverts `StaleSeries`. Because that sample is taken
 *         inside the same transaction, a staker cannot stake against a
 *         crossing the feed already shows: the fresh sample is scanned before
 *         the stake is accepted, and the whole transaction reverts if it
 *         crosses. When the tape is still within its cadence (so no new
 *         sample is possible), `takeSide` ALSO reads the live Pyth price and
 *         reverts `MarketCrossed` if that price, published inside the window,
 *         already satisfies the crossing condition; if the live price cannot
 *         be read or recorded (too old, bad expo) it is ignored, since it can
 *         never reach the tape. So a staker
 *         cannot act on a live price that is ahead of the recorded tape.
 *         Residual: a crossing Pyth publishes after this transaction but
 *         before the next sample is, by construction, not yet knowable.
 *
 *         SERIES BINDING IS FIXED AT CONSTRUCTION. There is no
 *         `registerSeries`: the (seriesId -> CanonicalSeries) map is set once
 *         in the constructor, so an id cannot be front-run, squatted or
 *         re-pointed. A new series means a new market contract, the same "no
 *         setter, no admin" rule as the rest of this package.
 *
 *         Payout math: simple pari-mutuel, proportional to stake, not a
 *         per-capita split and not an AMM. Every winning stake is repaid its
 *         principal back plus its pro-rata share of the losing pool
 *         (`payout = userWinningStake * (yesPool + noPool) / winningPool`). This
 *         was a judgment call — "equal-weighted pool split among winners" in
 *         the task that produced this file could also mean splitting the pool
 *         per-head regardless of stake size, but that is trivially griefable
 *         (stake 1 wei, capture an equal share) and is not how any real
 *         prediction market pays out. Pari-mutuel is the standard "simple, no
 *         AMM" payout model and is what's implemented here. No pricing curve,
 *         no odds that move as people bet — that is explicitly out of scope
 *         for this pass.
 */
contract ThresholdMarket is ReentrancyGuard {
    struct Market {
        address seriesContract;
        int256 thresholdPrice;
        bool above;
        uint256 windowStart;
        uint256 windowEnd;
        uint256 yesPool;
        uint256 noPool;
        bool settled;
        bool unresolvable;
        bool yesWon;
    }

    /// @notice Mirrors `CanonicalSeries.MAX_LOOKBACK_BUCKETS`: the widest
    ///         bucket span `swingHigh`/`swingLow` will scan. A market whose
    ///         window is wider could never be settled (or checked for a
    ///         crossing), so `openMarket` refuses it.
    uint256 public constant MAX_WINDOW_BUCKETS = 2_000;

    uint256 public nextMarketId;
    mapping(uint256 => Market) public markets;

    /// @dev seriesId -> CanonicalSeries contract address. Set once, in the
    ///      constructor; no function can add, change or remove an entry, so
    ///      an id cannot be squatted or re-pointed after deployment.
    mapping(bytes32 => address) public series;

    mapping(uint256 => mapping(address => uint256)) public yesStake;
    mapping(uint256 => mapping(address => uint256)) public noStake;
    mapping(uint256 => mapping(address => bool)) public claimed;

    event SeriesRegistered(bytes32 indexed seriesId, address indexed seriesContract);
    event MarketOpened(
        uint256 indexed marketId,
        bytes32 indexed seriesId,
        int256 thresholdPrice,
        bool above,
        uint256 windowStart,
        uint256 windowEnd
    );
    event SideTaken(uint256 indexed marketId, address indexed staker, bool takesYes, uint256 amount);
    event MarketSettled(uint256 indexed marketId, bool yesWon);
    event MarketUnresolvable(uint256 indexed marketId);
    event Claimed(uint256 indexed marketId, address indexed staker, uint256 amount);

    error SeriesNotRegistered();
    error InvalidWindow();
    error UnknownMarket();
    error MarketClosed();
    error MarketCrossed();
    error StaleSeries();
    error ZeroStake();
    error WindowNotOver();
    error AlreadySettled();
    error NotSettled();
    error AlreadyClaimed();
    error NothingToClaim();
    error TransferFailed();

    constructor(bytes32[] memory seriesIds, address[] memory seriesContracts) {
        require(seriesIds.length > 0 && seriesIds.length == seriesContracts.length, "series required");
        for (uint256 i = 0; i < seriesIds.length; i++) {
            require(seriesIds[i] != bytes32(0) && seriesContracts[i] != address(0), "series required");
            require(series[seriesIds[i]] == address(0), "duplicate series id");
            series[seriesIds[i]] = seriesContracts[i];
            emit SeriesRegistered(seriesIds[i], seriesContracts[i]);
        }
    }

    function openMarket(
        bytes32 seriesId,
        int256 thresholdPrice,
        bool above,
        uint256 windowStart,
        uint256 windowEnd
    ) external returns (uint256 marketId) {
        address seriesContract = series[seriesId];
        if (seriesContract == address(0)) revert SeriesNotRegistered();
        if (windowStart >= windowEnd) revert InvalidWindow();
        ICanonicalSeries s = ICanonicalSeries(seriesContract);
        if (s.bucketIndexOf(windowEnd) - s.bucketIndexOf(windowStart) >= MAX_WINDOW_BUCKETS) revert InvalidWindow();

        marketId = nextMarketId++;
        markets[marketId] = Market({
            seriesContract: seriesContract,
            thresholdPrice: thresholdPrice,
            above: above,
            windowStart: windowStart,
            windowEnd: windowEnd,
            yesPool: 0,
            noPool: 0,
            settled: false,
            unresolvable: false,
            yesWon: false
        });

        emit MarketOpened(marketId, seriesId, thresholdPrice, above, windowStart, windowEnd);
    }

    /// @notice Stakes on YES (`takesAboveSide == true`) or NO. Open until the
    ///         market's window ends, and closed the moment the series has
    ///         recorded a crossing sample inside the window (`MarketCrossed`).
    ///         Requires a fresh series (`StaleSeries`): see contract NatSpec.
    function takeSide(uint256 marketId, bool takesAboveSide) external payable nonReentrant {
        Market storage m = markets[marketId];
        if (m.seriesContract == address(0)) revert UnknownMarket();
        if (m.settled) revert MarketClosed();
        if (block.timestamp >= m.windowEnd) revert MarketClosed();
        if (msg.value == 0) revert ZeroStake();

        ICanonicalSeries s = ICanonicalSeries(m.seriesContract);
        _requireFresh(s);
        if (_crossed(m, s)) revert MarketCrossed();
        _requireLiveNotCrossed(m, s);

        if (takesAboveSide) {
            yesStake[marketId][msg.sender] += msg.value;
            m.yesPool += msg.value;
        } else {
            noStake[marketId][msg.sender] += msg.value;
            m.noPool += msg.value;
        }

        emit SideTaken(marketId, msg.sender, takesAboveSide, msg.value);
    }

    /// @notice True once the series has recorded a sample inside the market's
    ///         window (up to now) that satisfies the crossing condition — the
    ///         same test `takeSide` applies. Pure read of the tape as it is;
    ///         does not sample.
    function hasCrossed(uint256 marketId) external view returns (bool) {
        Market storage m = markets[marketId];
        if (m.seriesContract == address(0)) revert UnknownMarket();
        return _crossed(m, ICanonicalSeries(m.seriesContract));
    }

    /// @dev The series must have been sampled within the last cadence. If not,
    ///      take a sample now (permissionless on the series); if the tape is
    ///      still stale afterwards, refuse.
    function _requireFresh(ICanonicalSeries s) internal {
        uint256 cadence = s.cadenceSeconds();
        uint256 last = s.lastSampleTimestamp();
        if (last != 0 && block.timestamp <= last + cadence) return;

        try s.recordSample() { } catch { }

        last = s.lastSampleTimestamp();
        if (last == 0 || block.timestamp > last + cadence) revert StaleSeries();
    }

    /// @dev Reads the live Pyth price the series samples and refuses a stake
    ///      if that price, published inside the window, already crosses. A live price
    ///      the series could not record anyway (too old, wrong expo) is ignored.
    function _requireLiveNotCrossed(Market storage m, ICanonicalSeries s) internal view {
        PythStructs.Price memory p;
        try s.pyth().getPriceNoOlderThan(s.feedId(), s.maxPriceAgeSeconds()) returns (PythStructs.Price memory got) {
            p = got;
        } catch {
            // Older than the series' max age, or no price: `recordSample` would
            // reject it too, so it can never reach the tape. Nothing to guard.
            return;
        }
        if (p.expo != s.priceExpo()) return; // unrecordable as well
        if (p.publishTime < m.windowStart || p.publishTime > m.windowEnd) return;
        bool crossed = m.above ? int256(p.price) >= m.thresholdPrice : int256(p.price) <= m.thresholdPrice;
        if (crossed) revert MarketCrossed();
    }

    /// @dev Crossing test over recorded samples published in
    ///      [windowStart, min(windowEnd, now)]; settlement uses the same test
    ///      over the full window.
    function _crossed(Market storage m, ICanonicalSeries s) internal view returns (bool) {
        uint256 end = block.timestamp < m.windowEnd ? block.timestamp : m.windowEnd;
        if (m.windowStart > end) return false; // the window has not begun
        (bool found, bool hit) = _scan(m, s, end);
        return found && hit;
    }

    function _scan(Market storage m, ICanonicalSeries s, uint256 end) internal view returns (bool found, bool hit) {
        if (m.above) {
            (int64 high, bool f) = s.windowHigh(m.windowStart, end);
            return (f, int256(high) >= m.thresholdPrice);
        }
        (int64 low, bool fl) = s.windowLow(m.windowStart, end);
        return (fl, int256(low) <= m.thresholdPrice);
    }

    /// @notice Permissionless. Reads only recorded candles in
    ///         [windowStart, windowEnd]. Marks the market unresolvable, rather
    ///         than guessing, when there are zero recorded candles in that
    ///         range.
    function settle(uint256 marketId) external {
        Market storage m = markets[marketId];
        if (m.settled) revert AlreadySettled();
        if (m.seriesContract == address(0)) revert UnknownMarket();
        ICanonicalSeries s = ICanonicalSeries(m.seriesContract);
        // The tape for the window is final only once no sample published at or
        // before `windowEnd` can still be recorded.
        if (block.timestamp <= m.windowEnd + s.maxPriceAgeSeconds()) revert WindowNotOver();

        m.settled = true;

        (bool found, bool hit) = _scan(m, s, m.windowEnd);
        if (!found) {
            m.unresolvable = true;
            emit MarketUnresolvable(marketId);
            return;
        }
        m.yesWon = hit;

        emit MarketSettled(marketId, m.yesWon);
    }

    /// @notice Pays out a settled market. Unresolvable markets refund both
    ///         sides' principal. A settled, resolvable market with zero stake
    ///         on the winning side also refunds principal, since there is no
    ///         counterparty pool to pay winners from.
    function claim(uint256 marketId) external nonReentrant {
        Market storage m = markets[marketId];
        if (!m.settled) revert NotSettled();
        if (claimed[marketId][msg.sender]) revert AlreadyClaimed();

        uint256 payout;

        if (m.unresolvable) {
            payout = yesStake[marketId][msg.sender] + noStake[marketId][msg.sender];
        } else {
            uint256 winningPool = m.yesWon ? m.yesPool : m.noPool;
            uint256 totalPool = m.yesPool + m.noPool;
            uint256 userWinningStake = m.yesWon ? yesStake[marketId][msg.sender] : noStake[marketId][msg.sender];

            if (winningPool == 0) {
                payout = yesStake[marketId][msg.sender] + noStake[marketId][msg.sender];
            } else {
                payout = (userWinningStake * totalPool) / winningPool;
            }
        }

        if (payout == 0) revert NothingToClaim();

        claimed[marketId][msg.sender] = true;

        (bool ok,) = msg.sender.call{ value: payout }("");
        if (!ok) revert TransferFailed();

        emit Claimed(marketId, msg.sender, payout);
    }

    // TODO(follow-up, later pass): margin accounts, vaults and copy-trading
    // contracts for the broader multi-asset trading terminal are not built in
    // this pass. When they land, they should follow the patterns established
    // here and in CanonicalSeries/StrategyRegistry: immutable pinned config,
    // permissionless settlement gated on recorded on-chain data only, no
    // admin override, and any cooling-off-style mutation (e.g. widening a
    // margin limit) going through the same propose/cooldown/finalize shape as
    // StrategyRegistry.proposeLoosening/finalizeLoosening.
}
