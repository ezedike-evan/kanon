// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import { Test } from "forge-std/Test.sol";
import { CanonicalSeries } from "../src/CanonicalSeries.sol";
import { ThresholdMarket } from "../src/ThresholdMarket.sol";
import { MockPyth } from "./mocks/MockPyth.sol";

contract ThresholdMarketTest is Test {
    bytes32 constant FEED = bytes32(uint256(1));
    bytes32 constant SERIES_ID = keccak256("btc-usd-15m");
    uint256 constant CADENCE = 300;
    uint256 constant BUCKET = 900;
    uint256 constant MAX_AGE = 60;
    uint256 constant T0 = 1_000_000 * BUCKET;

    MockPyth pyth;
    CanonicalSeries series;
    ThresholdMarket market;

    address alice = address(0xA11CE);
    address bob = address(0xB0B);
    address carol = address(0xCA401);

    function setUp() public {
        pyth = new MockPyth();
        series = new CanonicalSeries("BTC/USD", FEED, CADENCE, BUCKET, address(pyth), MAX_AGE);
        market = _newMarket();

        vm.warp(T0);
        vm.deal(alice, 10 ether);
        vm.deal(bob, 10 ether);
        vm.deal(carol, 10 ether);
    }

    function _newMarket() internal returns (ThresholdMarket m) {
        bytes32[] memory ids = new bytes32[](1);
        ids[0] = SERIES_ID;
        address[] memory addrs = new address[](1);
        addrs[0] = address(series);
        m = new ThresholdMarket(ids, addrs);
    }

    function _record(int64 price) internal {
        pyth.setPrice(FEED, price, 1, -8, block.timestamp);
        series.recordSample();
    }

    /// @dev Sets the feed price without recording it on the series.
    function _feed(int64 price) internal {
        pyth.setPrice(FEED, price, 1, -8, block.timestamp);
    }

    // ------------------------------------------------------------------
    // Settlement and payouts (unchanged behavior)
    // ------------------------------------------------------------------

    function test_Settle_YesWins_WhenRecordedHighCrossesThreshold_AboveMarket() public {
        uint256 windowStart = block.timestamp;

        vm.prank(alice);
        market.openMarket(SERIES_ID, 100_000, true, windowStart, windowStart + 3 * BUCKET);
        uint256 marketId = 0;

        _record(90_000); // fresh tape, below the threshold: staking is open
        vm.prank(alice);
        market.takeSide{ value: 1 ether }(marketId, true); // bets YES: price reaches >= 100_000
        vm.prank(bob);
        market.takeSide{ value: 1 ether }(marketId, false); // bets NO

        vm.warp(block.timestamp + BUCKET);
        _record(105_000); // crosses the threshold
        vm.warp(block.timestamp + BUCKET);
        _record(95_000);

        vm.warp(windowStart + 3 * BUCKET + MAX_AGE + 1);
        market.settle(marketId);

        (,,,,,,, bool settled, bool unresolvable, bool yesWon) = market.markets(marketId);
        assertTrue(settled);
        assertFalse(unresolvable);
        assertTrue(yesWon);

        uint256 aliceBefore = alice.balance;
        vm.prank(alice);
        market.claim(marketId);
        // Sole winner takes the full pool (own 1 ether + bob's 1 ether).
        assertEq(alice.balance - aliceBefore, 2 ether);

        vm.prank(bob);
        vm.expectRevert();
        market.claim(marketId); // loser has nothing to claim
    }

    function test_Settle_NoWins_WhenRecordedHighNeverCrossesThreshold_AboveMarket() public {
        uint256 windowStart = block.timestamp;

        market.openMarket(SERIES_ID, 200_000, true, windowStart, windowStart + 2 * BUCKET);
        uint256 marketId = 0;

        _record(90_000);
        vm.prank(alice);
        market.takeSide{ value: 1 ether }(marketId, true); // YES
        vm.prank(bob);
        market.takeSide{ value: 3 ether }(marketId, false); // NO

        vm.warp(block.timestamp + BUCKET);
        _record(95_000); // never reaches 200_000

        vm.warp(windowStart + 2 * BUCKET + MAX_AGE + 1);
        market.settle(marketId);

        (,,,,,,, bool settled, bool unresolvable, bool yesWon) = market.markets(marketId);
        assertTrue(settled);
        assertFalse(unresolvable);
        assertFalse(yesWon);

        uint256 bobBefore = bob.balance;
        vm.prank(bob);
        market.claim(marketId);
        assertEq(bob.balance - bobBefore, 4 ether); // full pool, sole winner
    }

    function test_Settle_BelowMarket_YesWinsWhenLowDropsAtOrBelowThreshold() public {
        uint256 windowStart = block.timestamp;

        market.openMarket(SERIES_ID, 80_000, false, windowStart, windowStart + 2 * BUCKET);
        uint256 marketId = 0;

        _record(100_000);
        vm.prank(alice);
        market.takeSide{ value: 2 ether }(marketId, true); // YES: price dips to <= 80_000

        vm.warp(block.timestamp + BUCKET);
        _record(75_000); // dips below threshold

        vm.warp(windowStart + 2 * BUCKET + MAX_AGE + 1);
        market.settle(marketId);

        (,,,,,,, bool settled, bool unresolvable, bool yesWon) = market.markets(marketId);
        assertTrue(settled);
        assertFalse(unresolvable);
        assertTrue(yesWon);
    }

    function test_Settle_MarksUnresolvable_WhenZeroRecordedSamplesInWindow() public {
        // The window starts a bucket from now, so stakes can be taken (against
        // a fresh sample) BEFORE it begins; nobody records anything inside it.
        uint256 windowStart = block.timestamp + BUCKET;
        market.openMarket(SERIES_ID, 100_000, true, windowStart, windowStart + 2 * BUCKET);
        uint256 marketId = 0;

        _record(90_000); // in the bucket before the window: not part of it
        vm.prank(alice);
        market.takeSide{ value: 1 ether }(marketId, true);
        vm.prank(bob);
        market.takeSide{ value: 1 ether }(marketId, false);

        vm.warp(windowStart + 2 * BUCKET + MAX_AGE + 1);
        market.settle(marketId);

        (,,,,,,, bool settled, bool unresolvable,) = market.markets(marketId);
        assertTrue(settled);
        assertTrue(unresolvable, "zero recorded samples in window must mark unresolvable, never guess");

        // Both sides get their own principal back.
        uint256 aliceBefore = alice.balance;
        vm.prank(alice);
        market.claim(marketId);
        assertEq(alice.balance - aliceBefore, 1 ether);

        uint256 bobBefore = bob.balance;
        vm.prank(bob);
        market.claim(marketId);
        assertEq(bob.balance - bobBefore, 1 ether);
    }

    function test_Settle_RevertsBeforeWindowEnds() public {
        uint256 windowStart = block.timestamp;
        market.openMarket(SERIES_ID, 100_000, true, windowStart, windowStart + 2 * BUCKET);
        vm.expectRevert();
        market.settle(0);
    }

    function test_TakeSide_RevertsAfterWindowEnds() public {
        uint256 windowStart = block.timestamp;
        market.openMarket(SERIES_ID, 100_000, true, windowStart, windowStart + BUCKET);
        vm.warp(windowStart + BUCKET + 1);

        vm.prank(alice);
        vm.expectRevert();
        market.takeSide{ value: 1 ether }(0, true);
    }

    function test_OpenMarket_RevertsForUnregisteredSeries() public {
        vm.expectRevert();
        market.openMarket(keccak256("unknown"), 100_000, true, block.timestamp, block.timestamp + BUCKET);
    }

    function test_ProportionalPayout_SplitsWinningPoolByStake() public {
        uint256 windowStart = block.timestamp;
        market.openMarket(SERIES_ID, 100_000, true, windowStart, windowStart + 2 * BUCKET);
        uint256 marketId = 0;

        _record(90_000);
        vm.prank(alice);
        market.takeSide{ value: 1 ether }(marketId, true); // 1/3 of winning pool
        vm.prank(carol);
        market.takeSide{ value: 2 ether }(marketId, true); // 2/3 of winning pool
        vm.prank(bob);
        market.takeSide{ value: 3 ether }(marketId, false); // losing pool

        vm.warp(block.timestamp + BUCKET);
        _record(150_000);
        vm.warp(windowStart + 2 * BUCKET + MAX_AGE + 1);
        market.settle(marketId);

        uint256 aliceBefore = alice.balance;
        vm.prank(alice);
        market.claim(marketId);
        // total pool = 6 ether, alice owns 1/3 of the winning side -> 2 ether
        assertEq(alice.balance - aliceBefore, 2 ether);

        uint256 carolBefore = carol.balance;
        vm.prank(carol);
        market.claim(marketId);
        // carol owns 2/3 of the winning side -> 4 ether
        assertEq(carol.balance - carolBefore, 4 ether);
    }

    // ------------------------------------------------------------------
    // No staking on information already in the series
    // ------------------------------------------------------------------

    function test_TakeSide_RevertsOnceTheSeriesHasRecordedACrossing_Above() public {
        market.openMarket(SERIES_ID, 100_000, true, T0, T0 + 4 * BUCKET);

        _record(90_000);
        vm.prank(alice);
        market.takeSide{ value: 1 ether }(0, true); // before the cross: fine
        assertFalse(market.hasCrossed(0));

        vm.warp(block.timestamp + BUCKET);
        _record(101_000); // the tape now shows the threshold touched
        assertTrue(market.hasCrossed(0));

        // The winning side after the fact...
        vm.prank(bob);
        vm.expectRevert(ThresholdMarket.MarketCrossed.selector);
        market.takeSide{ value: 1 ether }(0, true);
        // ...and the (already lost) side: a closed market is closed to both.
        vm.prank(bob);
        vm.expectRevert(ThresholdMarket.MarketCrossed.selector);
        market.takeSide{ value: 1 ether }(0, false);

        // A crossing cannot be un-hit by a later retreat.
        vm.warp(block.timestamp + BUCKET);
        _record(80_000);
        vm.prank(bob);
        vm.expectRevert(ThresholdMarket.MarketCrossed.selector);
        market.takeSide{ value: 1 ether }(0, false);
    }

    function test_TakeSide_RevertsOnceTheSeriesHasRecordedACrossing_Below() public {
        market.openMarket(SERIES_ID, 80_000, false, T0, T0 + 4 * BUCKET);
        _record(100_000);
        vm.prank(alice);
        market.takeSide{ value: 1 ether }(0, true);

        vm.warp(block.timestamp + BUCKET);
        _record(79_000);
        vm.prank(bob);
        vm.expectRevert(ThresholdMarket.MarketCrossed.selector);
        market.takeSide{ value: 1 ether }(0, true);
    }

    function test_TakeSide_TouchingTheThresholdCounts_OneTickShortDoesNot() public {
        market.openMarket(SERIES_ID, 100_000, true, T0, T0 + 6 * BUCKET);

        _record(99_999); // one tick short of the threshold
        vm.prank(alice);
        market.takeSide{ value: 1 ether }(0, false);

        vm.warp(block.timestamp + BUCKET);
        _record(100_000); // exactly the threshold: `settle` calls this a hit, so staking closes
        vm.prank(bob);
        vm.expectRevert(ThresholdMarket.MarketCrossed.selector);
        market.takeSide{ value: 1 ether }(0, false);
    }

    function test_Boundary_CrossingBeforeTheWindowsFirstBucketDoesNotClose() public {
        uint256 windowStart = T0 + BUCKET;
        market.openMarket(SERIES_ID, 100_000, true, windowStart, windowStart + 3 * BUCKET);

        _record(150_000); // in bucket b0, which is NOT part of [b0+1, b0+4]
        assertFalse(market.hasCrossed(0));
        vm.prank(alice);
        market.takeSide{ value: 1 ether }(0, false);
        assertEq(market.noStake(0, alice), 1 ether);

        // ...and it is not counted at settlement either: NO wins.
        vm.warp(windowStart + BUCKET);
        _record(90_000);
        vm.warp(windowStart + 3 * BUCKET + MAX_AGE + 1);
        market.settle(0);
        (,,,,,,,,, bool yesWon) = market.markets(0);
        assertFalse(yesWon);
    }

    function test_Boundary_CrossingInTheFirstWindowBucketCloses() public {
        uint256 windowStart = T0 + BUCKET;
        market.openMarket(SERIES_ID, 100_000, true, windowStart, windowStart + 3 * BUCKET);
        vm.warp(windowStart);
        _record(100_500); // first bucket of the window
        assertTrue(market.hasCrossed(0));
        vm.prank(alice);
        vm.expectRevert(ThresholdMarket.MarketCrossed.selector);
        market.takeSide{ value: 1 ether }(0, false);
    }

    /// @dev `windowEnd` mid-bucket: the bucket containing `windowEnd` is part
    ///      of the window (as at settlement), and stakes are still open until
    ///      `windowEnd` itself. A crossing recorded in that last bucket closes
    ///      them.
    function test_Boundary_CrossingInTheLastWindowBucketCloses() public {
        uint256 windowEnd = T0 + 2 * BUCKET + 400;
        market.openMarket(SERIES_ID, 100_000, true, T0, windowEnd);

        _record(90_000);
        vm.warp(T0 + 2 * BUCKET + 10); // start of the last bucket, before windowEnd
        _record(101_000);
        assertTrue(market.hasCrossed(0));
        vm.prank(alice);
        vm.expectRevert(ThresholdMarket.MarketCrossed.selector);
        market.takeSide{ value: 1 ether }(0, false);
    }

    function test_Boundary_StakeAllowedInTheLastBucketIfNothingCrossedYet() public {
        uint256 windowEnd = T0 + 2 * BUCKET + 400;
        market.openMarket(SERIES_ID, 100_000, true, T0, windowEnd);
        vm.warp(T0 + 2 * BUCKET + 10);
        _record(90_000);
        vm.prank(alice);
        market.takeSide{ value: 1 ether }(0, true);
        vm.warp(windowEnd);
        vm.prank(alice);
        vm.expectRevert(ThresholdMarket.MarketClosed.selector); // time closes at windowEnd
        market.takeSide{ value: 1 ether }(0, true);
    }

    function test_HasCrossed_UnknownMarketReverts() public {
        vm.expectRevert(ThresholdMarket.UnknownMarket.selector);
        market.hasCrossed(7);
        vm.expectRevert(ThresholdMarket.UnknownMarket.selector);
        market.takeSide{ value: 1 }(7, true);
    }

    // ------------------------------------------------------------------
    // Freshness
    // ------------------------------------------------------------------

    function test_TakeSide_RevertsWhenTheSeriesIsStaleAndCannotBeRefreshed() public {
        market.openMarket(SERIES_ID, 100_000, true, T0, T0 + 4 * BUCKET);
        // Never sampled, and the feed has no price: nothing to refresh from.
        vm.prank(alice);
        vm.expectRevert(ThresholdMarket.StaleSeries.selector);
        market.takeSide{ value: 1 ether }(0, true);

        // Sampled long ago, feed price now too old for the series to accept.
        _record(90_000);
        vm.warp(block.timestamp + CADENCE + MAX_AGE + 1);
        vm.prank(alice);
        vm.expectRevert(ThresholdMarket.StaleSeries.selector);
        market.takeSide{ value: 1 ether }(0, true);
    }

    /// @notice A crossing the FEED already shows but the tape does not yet:
    ///         the stake attempt takes a fresh sample in-transaction, sees the
    ///         crossing, and reverts. The stale tape cannot hide it.
    function test_TakeSide_FreshSampleTakenInTheSameTxRevealsAHiddenCrossing() public {
        market.openMarket(SERIES_ID, 100_000, true, T0, T0 + 4 * BUCKET);
        _record(90_000);

        vm.warp(block.timestamp + CADENCE + 1); // tape is stale by cadence
        _feed(120_000); // the feed has crossed; nobody has recorded it
        assertFalse(market.hasCrossed(0), "the tape alone does not show it yet");

        uint256 lastBefore = series.lastSampleTimestamp();
        vm.prank(alice);
        vm.expectRevert(ThresholdMarket.MarketCrossed.selector);
        market.takeSide{ value: 1 ether }(0, true);
        assertEq(series.lastSampleTimestamp(), lastBefore, "the reverted tx recorded nothing");
        assertEq(market.yesStake(0, alice), 0);
    }

    function test_TakeSide_RefreshesTheTapeItselfWhenTheFeedIsFreshAndBelow() public {
        market.openMarket(SERIES_ID, 100_000, true, T0, T0 + 4 * BUCKET);
        _record(90_000);
        vm.warp(block.timestamp + CADENCE + 1);
        _feed(91_000);

        uint256 lastBefore = series.lastSampleTimestamp();
        vm.prank(alice);
        market.takeSide{ value: 1 ether }(0, true);
        assertGt(series.lastSampleTimestamp(), lastBefore, "takeSide refreshed the series");
    }

    function test_TakeSide_NoResampleNeededWhileTheTapeIsWithinOneCadence() public {
        market.openMarket(SERIES_ID, 100_000, true, T0, T0 + 4 * BUCKET);
        _record(90_000);
        vm.warp(block.timestamp + CADENCE); // still exactly within cadence
        uint256 lastBefore = series.lastSampleTimestamp();
        vm.prank(alice);
        market.takeSide{ value: 1 ether }(0, true);
        assertEq(series.lastSampleTimestamp(), lastBefore);
    }

    // ------------------------------------------------------------------
    // Squat resistance: series ids are fixed at construction
    // ------------------------------------------------------------------

    function test_SeriesIds_AreFixedAtConstruction_NoRegisterSeries() public {
        assertEq(market.series(SERIES_ID), address(series));

        // The old permissionless entry point no longer exists.
        (bool ok,) = address(market).call(
            abi.encodeWithSignature("registerSeries(bytes32,address)", keccak256("squat"), address(0xBAD))
        );
        assertFalse(ok);
        assertEq(market.series(keccak256("squat")), address(0));
    }

    function test_Constructor_Validates() public {
        bytes32[] memory ids = new bytes32[](2);
        ids[0] = SERIES_ID;
        ids[1] = SERIES_ID;
        address[] memory addrs = new address[](2);
        addrs[0] = address(series);
        addrs[1] = address(series);
        vm.expectRevert("duplicate series id");
        new ThresholdMarket(ids, addrs);

        vm.expectRevert("series required");
        new ThresholdMarket(new bytes32[](0), new address[](0));

        bytes32[] memory one = new bytes32[](1);
        one[0] = SERIES_ID;
        vm.expectRevert("series required");
        new ThresholdMarket(one, new address[](2));

        addrs = new address[](1);
        vm.expectRevert("series required");
        new ThresholdMarket(one, addrs); // zero address
    }

    function test_OpenMarket_RejectsAWindowWiderThanTheSeriesCanScan() public {
        uint256 tooWide = T0 + market.MAX_WINDOW_BUCKETS() * BUCKET;
        vm.expectRevert(ThresholdMarket.InvalidWindow.selector);
        market.openMarket(SERIES_ID, 100_000, true, T0, tooWide);
        market.openMarket(SERIES_ID, 100_000, true, T0, tooWide - BUCKET); // widest allowed
    }

    // ------------------------------------------------------------------
    // Fuzz: nobody can profit from information already in the series
    // ------------------------------------------------------------------

    struct Stake {
        address who;
        bool yes;
        uint256 index; // global event ordinal at stake time
    }

    // ghost state
    Stake[] internal _stakes;
    uint256 internal _ordinal;
    uint256 internal _crossOrdinal = type(uint256).max; // ordinal at which the tape first showed a crossing
    int64 internal _feedPrice;
    uint256 internal _feedTime;

    uint256 constant FZ_THRESHOLD = 100_000;

    function _ghostObserveSample(int64 price, uint256 publishTime, uint256 wStart, uint256 wEnd) internal {
        uint256 b = publishTime / BUCKET;
        if (b >= wStart / BUCKET && b <= wEnd / BUCKET && uint256(int256(price)) >= FZ_THRESHOLD) {
            if (_crossOrdinal == type(uint256).max) _crossOrdinal = _ordinal;
        }
    }

    /// @notice Random interleavings of price moves, direct sampling and stake
    ///         attempts on both sides. An INDEPENDENT ghost model of the tape
    ///         (built from the prices the test itself pushed, plus the sample
    ///         `takeSide` records when it refreshes a stale tape) must agree
    ///         that no stake was ever accepted once the tape showed a crossing,
    ///         and, when the crossing is real, that every YES stake predates
    ///         it — so no staker's payout can depend on information that was
    ///         already recorded when they staked.
    function testFuzz_NoStakerProfitsFromInformationAlreadyInTheSeries(uint256 seed) public {
        uint256 wStart = T0;
        uint256 wEnd = T0 + 8 * BUCKET;
        market.openMarket(SERIES_ID, int256(FZ_THRESHOLD), true, wStart, wEnd);

        address[3] memory actors = [alice, bob, carol];
        _feedPrice = 90_000;
        _feedTime = block.timestamp;
        pyth.setPrice(FEED, _feedPrice, 1, -8, _feedTime);

        for (uint256 i = 0; i < 24; i++) {
            uint256 r = uint256(keccak256(abi.encode(seed, i)));
            vm.warp(block.timestamp + 20 + (r % 700));
            if (block.timestamp >= wEnd) break;
            _ordinal++;

            uint256 action = (r >> 16) % 4;
            if (action == 0) {
                // the feed moves
                _feedPrice = int64(int256(80_000 + ((r >> 32) % 40_000)));
                _feedTime = block.timestamp;
                pyth.setPrice(FEED, _feedPrice, 1, -8, _feedTime);
            } else if (action == 1) {
                // someone records the feed directly (may be blocked by cadence or age)
                try series.recordSample() {
                    _ghostObserveSample(_feedPrice, _feedTime, wStart, wEnd);
                } catch { }
            } else {
                address who = actors[(r >> 48) % 3];
                bool yes = ((r >> 60) & 1) == 1;
                uint256 lastBefore = series.lastSampleTimestamp();
                vm.prank(who);
                try market.takeSide{ value: 1 ether }(0, yes) {
                    if (series.lastSampleTimestamp() != lastBefore) {
                        // takeSide refreshed the tape in this tx: that sample is on the tape.
                        _ghostObserveSample(_feedPrice, _feedTime, wStart, wEnd);
                    }
                    // THE PROPERTY: once accepted, the independent ghost must NOT
                    // see a crossing on the tape.
                    assertEq(_crossOrdinal, type(uint256).max, "stake accepted after the tape showed a crossing");
                    _stakes.push(Stake({ who: who, yes: yes, index: _ordinal }));
                } catch { }
            }
        }

        // Settle and check the payout side of the property.
        vm.warp(wEnd + MAX_AGE + 1);
        market.settle(0);
        (,,,,,,, , bool unresolvable, bool yesWon) = market.markets(0);

        if (!unresolvable && yesWon) {
            // The market resolved YES on a crossing. Every stake (on either side)
            // was accepted while the tape had no crossing recorded, so all of
            // them predate it: there is no late YES stake to have profited.
            for (uint256 k = 0; k < _stakes.length; k++) {
                assertLt(_stakes[k].index, _crossOrdinal, "a stake postdates the recorded crossing");
            }
        }
    }
}
