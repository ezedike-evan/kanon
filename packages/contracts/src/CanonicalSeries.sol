// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import { IPyth } from "./pyth/IPyth.sol";
import { PythStructs } from "./pyth/PythStructs.sol";

/**
 * @title ICanonicalSeries
 * @notice Read surface a consumer contract (e.g. ThresholdMarket, and eventually
 *         RefusalGate once predicate math is ported on-chain) needs from a
 *         CanonicalSeries. Kept as an interface so those consumers can be tested
 *         against a mock without depending on Pyth at all.
 */
interface ICanonicalSeries {
    function bucketIndexOf(uint256 timestamp) external view returns (uint256);

    /// @notice Minimum seconds between two permissionless `recordSample`
    ///         calls. A consumer that needs "fresh" data (`ThresholdMarket`)
    ///         defines fresh as "sampled within the last cadence".
    function cadenceSeconds() external view returns (uint256);

    /// @notice `block.timestamp` of the last successful `recordSample`, 0 if never.
    function lastSampleTimestamp() external view returns (uint256);

    /// @notice Permissionless. Pulls the feed's current price into the tape.
    function recordSample() external;

    /// @notice Width of a candle bucket, in seconds. Needed by any consumer
    ///         (e.g. PredicateEngine) that has to recover a candle's bucket
    ///         *timestamp* from its bucket index, since `getCandle` itself
    ///         returns OHLC data only, not the bucket's start time.
    function bucketSeconds() external view returns (uint256);

    function getCandle(uint256 bucketIndex)
        external
        view
        returns (int64 open, int64 high, int64 low, int64 close, uint32 sampleCount, bool recorded);

    function swingHigh(uint256 fromBucketInclusive, uint256 toBucketInclusive)
        external
        view
        returns (int64 high, bool found);

    function swingLow(uint256 fromBucketInclusive, uint256 toBucketInclusive)
        external
        view
        returns (int64 low, bool found);

    /// @notice Highest recorded sample whose Pyth PUBLISH time lies in
    ///         [startTime, endTime] (both inclusive). Samples published
    ///         outside the window never participate, however they were bucketed.
    function windowHigh(uint256 startTime, uint256 endTime) external view returns (int64 high, bool found);

    /// @notice Lowest recorded sample published in [startTime, endTime], inclusive.
    function windowLow(uint256 startTime, uint256 endTime) external view returns (int64 low, bool found);

    /// @notice Max age a Pyth price may have when pulled. A sample published at
    ///         time `t` can be recorded no later than `t + maxPriceAgeSeconds`.
    function maxPriceAgeSeconds() external view returns (uint256);

    function pyth() external view returns (IPyth);
    function feedId() external view returns (bytes32);
    function priceExpo() external view returns (int32);
}

/**
 * @title CanonicalSeries
 * @notice Path 1 of docs/ARCHITECTURE.md's asymmetry: the contract keeps its own
 *         price tape by sampling a Pyth feed on a fixed cadence and bucketing
 *         samples into candles. A "swing high" is the maximum over *recorded*
 *         samples in this tape, never a claim about ticks nobody published here.
 *
 * @dev    Hard invariants this contract must never violate:
 *         - Never synthesize a price for a bucket nobody sampled. An empty
 *           bucket stays empty (`recorded == false`) forever; it is never
 *           interpolated, carried forward, or defaulted to zero.
 *         - `swingHigh`/`swingLow` only ever read `recorded` candles. A bucket
 *           with no sample simply does not participate in the max/min.
 *         - asset / feed / cadence / bucket size are pinned once, at
 *           construction, and never change. A spec that references this series
 *           is meaningless if any of the four can move under it.
 *
 *         Pyth's push feeds are event-driven (a 0.02% deviation threshold, not
 *         a uniform clock — see docs/ARCHITECTURE.md "Oracle"), so the on-chain
 *         "cadence" here is a *minimum interval between permissionless pulls*,
 *         not a promise that a sample lands every `cadenceSeconds`. Buckets are
 *         expected to be sparse; that is normal, not a bug.
 */
contract CanonicalSeries is ICanonicalSeries {
    struct Candle {
        int64 open;
        int64 high;
        int64 low;
        int64 close;
        uint32 sampleCount;
        bool recorded;
    }

    /// @notice Bounds the loop in swingHigh/swingLow so a caller cannot pass a
    ///         window large enough to run the contract out of gas.
    uint256 public constant MAX_LOOKBACK_BUCKETS = 2_000;

    /// @dev Reference type — Solidity does not allow `immutable` on `string`.
    ///      There is no setter anywhere in this contract, so it is immutable by
    ///      convention: set once in the constructor, never written again.
    string public asset;

    /// @notice The Pyth price feed id this series samples. Pinned at construction.
    bytes32 public immutable feedId;

    /// @notice Minimum seconds between two permissionless `recordSample` calls.
    uint256 public immutable cadenceSeconds;

    /// @notice Width of a candle bucket, in seconds. `bucketIndex = timestamp / bucketSeconds`.
    uint256 public immutable bucketSeconds;

    /// @notice How stale a Pyth price is allowed to be when pulled. Not one of
    ///         the four spec-pinned fields (asset/feed/cadence/bucket) called
    ///         out in docs/ARCHITECTURE.md, but pinned immutably for the same
    ///         reason: a mutable staleness bound would be a hidden parameter.
    uint256 public immutable maxPriceAgeSeconds;

    IPyth public immutable pyth;

    /// @dev The exponent Pyth reports for this feed (e.g. -8). Captured from the
    ///      first sample and required to match on every later sample so that
    ///      high/low comparisons across candles stay apples-to-apples. Pyth
    ///      exponents are expected stable per feed; if the feed ever changes its
    ///      exponent, `recordSample` reverts rather than silently comparing
    ///      mismatched fixed-point scales. That is a known limitation — recovery
    ///      would need a new series contract, not a mutable override.
    int32 public priceExpo;
    bool public priceExpoSet;

    /// @notice Timestamp of the last successful `recordSample` call, used to gate
    ///         the cadence. Not the same as a candle's bucket timestamp, which is
    ///         the *price's* publish time, not the call time.
    uint256 public lastSampleTimestamp;

    mapping(uint256 => Candle) private _candles;

    /// @dev One recorded sample: Pyth publish time and price, packed in a
    ///      single slot. Kept per bucket in recording order.
    struct Sample {
        uint64 publishTime;
        int64 price;
    }

    /// @dev Per-bucket sample trail. It exists so a consumer can ask "what did
    ///      the tape show between t0 and t1" without a whole bucket leaking
    ///      samples from outside [t0, t1] (the candle's high/low cannot be
    ///      windowed). Growth per bucket is bounded: calls are >= `cadenceSeconds`
    ///      apart and a sample published in bucket b can only be recorded
    ///      within `maxPriceAgeSeconds` of its publish time, so a bucket holds
    ///      at most about `(bucketSeconds + maxPriceAgeSeconds) / cadenceSeconds + 1`
    ///      samples. `windowHigh/Low` read the trail for at most the two
    ///      partially covered edge buckets; fully covered buckets use the candle.
    mapping(uint256 => Sample[]) private _samples;

    event SampleRecorded(
        uint256 indexed bucketIndex, int64 price, int32 expo, uint256 publishTime, address indexed caller
    );

    /// @notice Widest accepted confidence interval, as bps of price (2%).
    uint256 public constant MAX_CONF_BPS = 200;

    error CadenceNotElapsed(uint256 nextAllowedAt);
    error PriceExpoDrift(int32 expected, int32 got);
    error InvalidWindow();
    error WindowTooWide();
    error NonPositivePrice(int64 price);
    error PositiveExpo(int32 expo);
    error ConfidenceTooWide(uint64 conf, int64 price);

    constructor(
        string memory asset_,
        bytes32 feedId_,
        uint256 cadenceSeconds_,
        uint256 bucketSeconds_,
        address pyth_,
        uint256 maxPriceAgeSeconds_
    ) {
        require(bytes(asset_).length > 0, "asset required");
        require(feedId_ != bytes32(0), "feed required");
        require(cadenceSeconds_ > 0, "cadence required");
        require(bucketSeconds_ > 0, "bucket size required");
        require(pyth_ != address(0), "pyth required");
        require(maxPriceAgeSeconds_ > 0, "max age required");

        asset = asset_;
        feedId = feedId_;
        cadenceSeconds = cadenceSeconds_;
        bucketSeconds = bucketSeconds_;
        pyth = IPyth(pyth_);
        maxPriceAgeSeconds = maxPriceAgeSeconds_;
    }

    /// @notice Permissionless. Pulls the current Pyth price and buckets it.
    /// @dev Gated on `cadenceSeconds` having elapsed since the last successful
    ///      call — anyone may call it, but only once per cadence window takes
    ///      effect on-chain, which is what makes the "fixed cadence" claim true
    ///      rather than aspirational.
    function recordSample() external {
        if (lastSampleTimestamp != 0 && block.timestamp < lastSampleTimestamp + cadenceSeconds) {
            revert CadenceNotElapsed(lastSampleTimestamp + cadenceSeconds);
        }

        PythStructs.Price memory p = pyth.getPriceNoOlderThan(feedId, maxPriceAgeSeconds);

        // A zero or negative print, a positive exponent, or a wide confidence interval is
        // not a price the rules can be evaluated over. Reject it rather than record it.
        if (p.price <= 0) revert NonPositivePrice(p.price);
        if (p.expo > 0) revert PositiveExpo(p.expo);
        if (uint256(p.conf) * 10_000 > uint256(uint64(p.price)) * MAX_CONF_BPS) {
            revert ConfidenceTooWide(p.conf, p.price);
        }

        if (!priceExpoSet) {
            priceExpo = p.expo;
            priceExpoSet = true;
        } else if (p.expo != priceExpo) {
            revert PriceExpoDrift(priceExpo, p.expo);
        }

        uint256 bucketIndex = p.publishTime / bucketSeconds;
        Candle storage c = _candles[bucketIndex];

        if (!c.recorded) {
            c.open = p.price;
            c.high = p.price;
            c.low = p.price;
            c.close = p.price;
            c.sampleCount = 1;
            c.recorded = true;
        } else {
            if (p.price > c.high) c.high = p.price;
            if (p.price < c.low) c.low = p.price;
            c.close = p.price;
            c.sampleCount += 1;
        }

        _samples[bucketIndex].push(Sample({ publishTime: uint64(p.publishTime), price: p.price }));

        lastSampleTimestamp = block.timestamp;

        emit SampleRecorded(bucketIndex, p.price, p.expo, p.publishTime, msg.sender);
    }

    function bucketIndexOf(uint256 timestamp) public view returns (uint256) {
        return timestamp / bucketSeconds;
    }

    function getCandle(uint256 bucketIndex)
        public
        view
        returns (int64 open, int64 high, int64 low, int64 close, uint32 sampleCount, bool recorded)
    {
        Candle storage c = _candles[bucketIndex];
        return (c.open, c.high, c.low, c.close, c.sampleCount, c.recorded);
    }

    /// @notice Highest recorded sample published in [startTime, endTime] (inclusive).
    /// @dev Buckets fully inside the window use the candle's high; the (at most
    ///      two) edge buckets scan the per-sample trail and keep only samples
    ///      whose publish time is in the window. `found == false` when none.
    function windowHigh(uint256 startTime, uint256 endTime) public view returns (int64 high, bool found) {
        return _windowExtreme(startTime, endTime, true);
    }

    /// @notice Lowest recorded sample published in [startTime, endTime] (inclusive).
    function windowLow(uint256 startTime, uint256 endTime) public view returns (int64 low, bool found) {
        return _windowExtreme(startTime, endTime, false);
    }

    function _windowExtreme(uint256 startTime, uint256 endTime, bool wantHigh)
        internal
        view
        returns (int64 best, bool found)
    {
        if (startTime > endTime) revert InvalidWindow();
        uint256 fromBucket = startTime / bucketSeconds;
        uint256 toBucket = endTime / bucketSeconds;
        if (toBucket - fromBucket >= MAX_LOOKBACK_BUCKETS) revert WindowTooWide();

        for (uint256 i = fromBucket; i <= toBucket; i++) {
            Candle storage c = _candles[i];
            if (!c.recorded) continue;
            uint256 bStart = i * bucketSeconds;
            if (startTime <= bStart && endTime >= bStart + bucketSeconds - 1) {
                int64 v = wantHigh ? c.high : c.low;
                if (!found || (wantHigh ? v > best : v < best)) {
                    best = v;
                    found = true;
                }
                continue;
            }
            Sample[] storage trail = _samples[i];
            uint256 n = trail.length;
            for (uint256 j = 0; j < n; j++) {
                Sample memory sm = trail[j];
                if (sm.publishTime < startTime || sm.publishTime > endTime) continue;
                if (!found || (wantHigh ? sm.price > best : sm.price < best)) {
                    best = sm.price;
                    found = true;
                }
            }
        }
    }

    /// @notice Maximum `high` over recorded candles in [fromBucketInclusive, toBucketInclusive].
    /// @dev Unrecorded buckets are skipped, never synthesized. `found == false`
    ///      when the window contains zero recorded candles — that is the honest
    ///      answer, not zero and not a revert-masked default.
    function swingHigh(uint256 fromBucketInclusive, uint256 toBucketInclusive)
        public
        view
        returns (int64 high, bool found)
    {
        if (fromBucketInclusive > toBucketInclusive) revert InvalidWindow();
        if (toBucketInclusive - fromBucketInclusive >= MAX_LOOKBACK_BUCKETS) revert WindowTooWide();

        for (uint256 i = fromBucketInclusive; i <= toBucketInclusive; i++) {
            Candle storage c = _candles[i];
            if (!c.recorded) continue;
            if (!found || c.high > high) {
                high = c.high;
                found = true;
            }
        }
    }

    /// @notice Minimum `low` over recorded candles in [fromBucketInclusive, toBucketInclusive].
    /// @dev Same honesty rule as `swingHigh`: unrecorded buckets never participate.
    function swingLow(uint256 fromBucketInclusive, uint256 toBucketInclusive)
        public
        view
        returns (int64 low, bool found)
    {
        if (fromBucketInclusive > toBucketInclusive) revert InvalidWindow();
        if (toBucketInclusive - fromBucketInclusive >= MAX_LOOKBACK_BUCKETS) revert WindowTooWide();

        for (uint256 i = fromBucketInclusive; i <= toBucketInclusive; i++) {
            Candle storage c = _candles[i];
            if (!c.recorded) continue;
            if (!found || c.low < low) {
                low = c.low;
                found = true;
            }
        }
    }
}
