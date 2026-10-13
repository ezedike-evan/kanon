// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import { Test } from "forge-std/Test.sol";
import { CanonicalSeries } from "../src/CanonicalSeries.sol";
import { ThresholdMarket } from "../src/ThresholdMarket.sol";
import { MockPyth } from "./mocks/MockPyth.sol";

/// @dev Exact-window settlement: only samples PUBLISHED inside [windowStart, windowEnd]
///      count, regardless of how they share buckets with the window edges.
contract ThresholdMarketWindowTest is Test {
    bytes32 constant FEED = bytes32(uint256(1));
    bytes32 constant SERIES_ID = keccak256("btc-usd-15m");
    uint256 constant CADENCE = 30;
    uint256 constant BUCKET = 900;
    uint256 constant MAX_AGE = 60;
    uint256 constant T0 = 1_000_000 * BUCKET;

    MockPyth pyth;
    CanonicalSeries series;
    ThresholdMarket market;
    address alice = address(0xA11CE);

    function setUp() public {
        pyth = new MockPyth();
        series = new CanonicalSeries("BTC/USD", FEED, CADENCE, BUCKET, address(pyth), MAX_AGE);
        bytes32[] memory ids = new bytes32[](1);
        ids[0] = SERIES_ID;
        address[] memory addrs = new address[](1);
        addrs[0] = address(series);
        market = new ThresholdMarket(ids, addrs);
        vm.warp(T0);
        vm.deal(alice, 10 ether);
    }

    function _record(int64 price) internal {
        pyth.setPrice(FEED, price, 1, -8, block.timestamp);
        series.recordSample();
    }

    function _settleAfter(uint256 windowEnd) internal {
        vm.warp(windowEnd + MAX_AGE + 1);
        market.settle(0);
    }

    function _yesWon() internal view returns (bool yes, bool unresolvable) {
        (,,,,,,,, unresolvable, yes) = market.markets(0);
    }

    // ---- out-of-window samples cannot flip the outcome ----

    function test_SampleAfterWindowEnd_InEndBucket_CannotFlipToYes() public {
        uint256 ws = T0 + 100;
        uint256 we = T0 + 500; // same bucket as the crossing sample below
        market.openMarket(SERIES_ID, 100_000, true, ws, we);

        vm.warp(ws + 50);
        _record(90_000);
        vm.prank(alice);
        market.takeSide{ value: 1 ether }(0, false);

        vm.warp(we + 100); // T0 + 600, still bucket T0
        _record(150_000); // published after windowEnd: outside the window

        _settleAfter(we);
        (bool yes, bool unres) = _yesWon();
        assertFalse(unres);
        assertFalse(yes, "a post-window sample in the end bucket must not count");
    }

    function test_SampleBeforeWindowStart_InStartBucket_CannotFlipToYes() public {
        uint256 ws = T0 + 600;
        uint256 we = T0 + 600 + 2 * BUCKET;
        market.openMarket(SERIES_ID, 100_000, true, ws, we);

        vm.warp(T0 + 100);
        _record(150_000); // published before windowStart, same bucket as windowStart
        vm.warp(ws + 60);
        _record(90_000);
        assertFalse(market.hasCrossed(0));
        vm.prank(alice);
        market.takeSide{ value: 1 ether }(0, false);

        _settleAfter(we);
        (bool yes,) = _yesWon();
        assertFalse(yes, "a pre-window sample in the start bucket must not count");
    }

    function test_BelowMarket_OutOfWindowLowsDoNotCount() public {
        uint256 ws = T0 + 300;
        uint256 we = T0 + 600;
        market.openMarket(SERIES_ID, 80_000, false, ws, we);
        vm.warp(T0 + 100);
        _record(70_000); // before start
        vm.warp(ws + 30);
        _record(90_000);
        vm.warp(we + 100);
        _record(60_000); // after end
        _settleAfter(we);
        (bool yes, bool unres) = _yesWon();
        assertFalse(unres);
        assertFalse(yes);
    }

    // ---- boundary equality ----

    function test_SamplePublishedExactlyAtWindowEnd_Counts() public {
        uint256 ws = T0 + 100;
        uint256 we = T0 + 500;
        market.openMarket(SERIES_ID, 100_000, true, ws, we);
        vm.warp(ws + 50);
        _record(90_000);
        vm.warp(we);
        _record(100_000); // == threshold, published AT windowEnd
        _settleAfter(we);
        (bool yes,) = _yesWon();
        assertTrue(yes);
    }

    function test_SamplePublishedExactlyAtWindowStart_Counts() public {
        uint256 ws = T0 + 100;
        uint256 we = T0 + 2 * BUCKET;
        market.openMarket(SERIES_ID, 100_000, true, ws, we);
        vm.warp(ws);
        _record(100_000);
        assertTrue(market.hasCrossed(0));
        _settleAfter(we);
        (bool yes,) = _yesWon();
        assertTrue(yes);
    }

    function test_OneSecondOutsideEitherEdge_DoesNotCount() public {
        uint256 ws = T0 + 100;
        uint256 we = T0 + 500;
        market.openMarket(SERIES_ID, 100_000, true, ws, we);
        vm.warp(ws - 1);
        _record(100_000);
        vm.warp(we + 1);
        _record(100_000);
        _settleAfter(we);
        (bool yes, bool unres) = _yesWon();
        assertTrue(unres, "both samples are outside: nothing recorded in the window");
        assertFalse(yes);
    }

    // ---- settlement waits for the tape to be final ----

    function test_Settle_WaitsOutMaxPriceAge() public {
        uint256 ws = T0;
        uint256 we = T0 + 500;
        market.openMarket(SERIES_ID, 100_000, true, ws, we);
        vm.warp(we + MAX_AGE);
        vm.expectRevert(ThresholdMarket.WindowNotOver.selector);
        market.settle(0);
        vm.warp(we + MAX_AGE + 1);
        market.settle(0);
    }

    function test_LateRecordingOfInWindowSample_IsStillCountedBecauseSettleWaits() public {
        uint256 ws = T0;
        uint256 we = T0 + 500;
        market.openMarket(SERIES_ID, 100_000, true, ws, we);
        // Published inside the window at `we`, recorded MAX_AGE later, before settle is possible.
        pyth.setPrice(FEED, 120_000, 1, -8, we);
        vm.warp(we + MAX_AGE);
        series.recordSample();
        vm.expectRevert(ThresholdMarket.WindowNotOver.selector);
        market.settle(0);
        vm.warp(we + MAX_AGE + 1);
        market.settle(0);
        (bool yes,) = _yesWon();
        assertTrue(yes);
    }

    // ---- staking cannot act on a live price ahead of the tape ----

    function test_TakeSide_RevertsWhenLivePriceAheadOfTapeAlreadyCrosses() public {
        market.openMarket(SERIES_ID, 100_000, true, T0, T0 + 4 * BUCKET);
        _record(90_000);
        vm.warp(T0 + 10); // inside the cadence: no new sample possible
        pyth.setPrice(FEED, 150_000, 1, -8, block.timestamp); // live, unrecorded
        vm.prank(alice);
        vm.expectRevert(ThresholdMarket.MarketCrossed.selector);
        market.takeSide{ value: 1 ether }(0, false);
    }

    function test_TakeSide_LiveCrossingPublishedBeforeWindowDoesNotBlock() public {
        uint256 ws = T0 + BUCKET;
        market.openMarket(SERIES_ID, 100_000, true, ws, ws + 2 * BUCKET);
        _record(90_000);
        vm.warp(T0 + 10);
        pyth.setPrice(FEED, 150_000, 1, -8, block.timestamp); // before windowStart: irrelevant
        vm.prank(alice);
        market.takeSide{ value: 1 ether }(0, false);
        assertEq(market.noStake(0, alice), 1 ether);
    }

    // ---- CanonicalSeries window getters vs an independent model ----

    function testFuzz_WindowHighLow_MatchModel(uint256 seed, uint256 a, uint256 b) public {
        uint256 n = 12;
        uint256[] memory times = new uint256[](n);
        int64[] memory prices = new int64[](n);
        uint256 t = T0;
        for (uint256 i = 0; i < n; i++) {
            uint256 r = uint256(keccak256(abi.encode(seed, i)));
            t += CADENCE + (r % 400);
            vm.warp(t);
            times[i] = t;
            // From 50 up: `_record` prints a confidence of 1, and the series refuses a print whose
            // confidence is wider than MAX_CONF_BPS (2%) of its price, which a price under 50 is.
            prices[i] = int64(int256(50 + ((r >> 40) % 1_000_000)));
            _record(prices[i]);
        }
        uint256 lo = T0 + (a % (t - T0 + 200));
        uint256 hi = lo + (b % (t - T0 + 200));

        int64 mHigh;
        int64 mLow;
        bool mFound;
        for (uint256 i = 0; i < n; i++) {
            if (times[i] < lo || times[i] > hi) continue;
            if (!mFound || prices[i] > mHigh) mHigh = prices[i];
            if (!mFound || prices[i] < mLow) mLow = prices[i];
            mFound = true;
        }
        (int64 h, bool f1) = series.windowHigh(lo, hi);
        (int64 l, bool f2) = series.windowLow(lo, hi);
        assertEq(f1, mFound);
        assertEq(f2, mFound);
        if (mFound) {
            assertEq(h, mHigh);
            assertEq(l, mLow);
        }
    }

    function test_WindowGetters_RejectInvertedWindow() public {
        vm.expectRevert(CanonicalSeries.InvalidWindow.selector);
        series.windowHigh(10, 9);
    }
}
