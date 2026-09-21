// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import { Test } from "forge-std/Test.sol";
import { CanonicalSeries } from "../src/CanonicalSeries.sol";
import { MockPyth } from "./mocks/MockPyth.sol";

contract CanonicalSeriesTest is Test {
    bytes32 constant FEED = bytes32(uint256(1));
    uint256 constant CADENCE = 300; // 5 minutes
    uint256 constant BUCKET = 900; // 15 minutes
    uint256 constant MAX_AGE = 60;

    MockPyth pyth;
    CanonicalSeries series;

    function setUp() public {
        pyth = new MockPyth();
        series = new CanonicalSeries("BTC/USD", FEED, CADENCE, BUCKET, address(pyth), MAX_AGE);
        // Land on a clean bucket boundary so the math in tests is easy to reason about.
        vm.warp(1_000_000 * BUCKET);
    }

    function _setAndRecord(int64 price) internal {
        pyth.setPrice(FEED, price, 1, -8, block.timestamp);
        series.recordSample();
    }

    function test_PinsImmutableConfig() public view {
        assertEq(series.asset(), "BTC/USD");
        assertEq(series.feedId(), FEED);
        assertEq(series.cadenceSeconds(), CADENCE);
        assertEq(series.bucketSeconds(), BUCKET);
    }

    function test_RecordSample_OpenHighLowCloseOnFirstSample() public {
        int64 price = 65_000_00000000; // arbitrary fixed-point price
        _setAndRecord(price);

        uint256 bucketIndex = series.bucketIndexOf(block.timestamp);
        (int64 open, int64 high, int64 low, int64 close, uint32 sampleCount, bool recorded) =
            series.getCandle(bucketIndex);

        assertTrue(recorded);
        assertEq(open, price);
        assertEq(high, price);
        assertEq(low, price);
        assertEq(close, price);
        assertEq(sampleCount, 1);
    }

    function test_RecordSample_AggregatesHighLowWithinSameBucket() public {
        // Three samples, CADENCE apart, all landing in the same BUCKET window.
        _setAndRecord(100_000);
        vm.warp(block.timestamp + CADENCE);
        _setAndRecord(105_000); // new high
        vm.warp(block.timestamp + CADENCE);
        _setAndRecord(95_000); // new low, also final close

        uint256 bucketIndex = series.bucketIndexOf(block.timestamp);
        (int64 open, int64 high, int64 low, int64 close, uint32 sampleCount, bool recorded) =
            series.getCandle(bucketIndex);

        assertTrue(recorded);
        assertEq(open, 100_000);
        assertEq(high, 105_000);
        assertEq(low, 95_000);
        assertEq(close, 95_000);
        assertEq(sampleCount, 3);
    }

    function test_Cadence_RevertsWhenCalledTooSoon() public {
        _setAndRecord(100_000);
        pyth.setPrice(FEED, 101_000, 1, -8, block.timestamp);
        vm.expectRevert();
        series.recordSample();
    }

    function test_SparseBucket_IsHonestlyUnrecorded() public view {
        uint256 emptyBucket = series.bucketIndexOf(block.timestamp) + 5;
        (,,,,, bool recorded) = series.getCandle(emptyBucket);
        assertFalse(recorded, "an empty bucket must never report recorded == true");
    }

    /// @notice The core honesty property: a lookback window that spans several
    ///         empty buckets must compute its max/min only from the buckets
    ///         that actually have a recorded sample, and must say `found ==
    ///         false` when the whole window is empty rather than inventing 0.
    function test_SwingHigh_SwingLow_SkipUnrecordedBuckets() public {
        uint256 startBucket = series.bucketIndexOf(block.timestamp);

        _setAndRecord(100_000); // bucket 0 of the window

        // Skip two full buckets — nobody calls recordSample during them.
        vm.warp(block.timestamp + 2 * BUCKET);
        _setAndRecord(120_000); // this bucket is the swing high

        vm.warp(block.timestamp + 2 * BUCKET);
        _setAndRecord(90_000); // this bucket is the swing low

        uint256 endBucket = series.bucketIndexOf(block.timestamp);

        (int64 high, bool foundHigh) = series.swingHigh(startBucket, endBucket);
        (int64 low, bool foundLow) = series.swingLow(startBucket, endBucket);

        assertTrue(foundHigh);
        assertTrue(foundLow);
        assertEq(high, 120_000);
        assertEq(low, 90_000);
    }

    function test_SwingHigh_FoundFalse_WhenWindowFullyEmpty() public view {
        uint256 farFuture = series.bucketIndexOf(block.timestamp) + 1000;
        (int64 high, bool found) = series.swingHigh(farFuture, farFuture + 10);
        assertFalse(found, "an all-empty window must never claim a high");
        assertEq(high, 0);
    }

    function test_PriceExpoDrift_Reverts() public {
        pyth.setPrice(FEED, 100_000, 1, -8, block.timestamp);
        series.recordSample();

        vm.warp(block.timestamp + CADENCE);
        pyth.setPrice(FEED, 100_000, 1, -6, block.timestamp); // expo changed
        vm.expectRevert();
        series.recordSample();
    }

    function test_SwingHigh_RevertsOnInvertedWindow() public {
        vm.expectRevert();
        series.swingHigh(10, 5);
    }
}
