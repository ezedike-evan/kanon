// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import { Test } from "forge-std/Test.sol";
import { StrategyRegistry } from "../src/StrategyRegistry.sol";
import { RefusalGate } from "../src/RefusalGate.sol";
import { CanonicalSeries } from "../src/CanonicalSeries.sol";
import { PredicateEngine } from "../src/PredicateEngine.sol";
import { TradeSide } from "../src/TradeSide.sol";
import { MockPyth } from "./mocks/MockPyth.sol";
import { one } from "./helpers/GateFixture.sol";

contract TradeSideHarness {
    function side(
        PredicateEngine.PredicateKind kind,
        PredicateEngine.Direction dir,
        PredicateEngine.ReferenceExtreme ref
    ) external pure returns (bool isLong, bool consistent) {
        return TradeSide.predicateSide(kind, dir, ref);
    }
}

/**
 * @notice A rule whose committed predicates are all bullish must not approve a
 *         short, and vice versa. The side is a function of committed fields
 *         only; mixed rules and contradictory sweeps are rejected.
 */
contract TradeSideBindingTest is Test {
    uint256 constant BUCKET = 900;
    uint256 constant BASE = 1_000_000;
    bytes32 constant FEED = bytes32(uint256(1));

    MockPyth pyth;
    CanonicalSeries series;
    StrategyRegistry registry;
    RefusalGate gate;
    address owner = address(0xA11CE);
    address proposer = address(0xB0B);

    event TradeRefused(
        uint256 indexed strategyId,
        bytes32 indexed specHash,
        address indexed proposer,
        bytes32 predicateSymbol,
        int256 decidingValue
    );

    function setUp() public {
        pyth = new MockPyth();
        series = new CanonicalSeries("BTC/USD", FEED, 1, BUCKET, address(pyth), 60);
        registry = new StrategyRegistry(0.01 ether, 1 days, one(address(series)));
        gate = new RefusalGate(address(registry));
        vm.deal(owner, 10 ether);
        vm.warp(BASE * BUCKET);
    }

    // ---- helpers ------------------------------------------------------

    function _sample(int64 price) internal {
        pyth.setPrice(FEED, price, 1, -2, block.timestamp);
        series.recordSample();
    }

    function _candle(uint256 i, int64 price) internal {
        vm.warp((BASE + i) * BUCKET);
        _sample(price);
    }

    function _pred(
        PredicateEngine.PredicateKind kind,
        PredicateEngine.Direction dir,
        PredicateEngine.ReferenceExtreme ref
    ) internal pure returns (RefusalGate.PredicateDefinition memory) {
        return RefusalGate.PredicateDefinition({
            kind: kind,
            symbol: "p",
            direction: dir,
            swingLookbackCandles: 1,
            minGapBps: 1,
            referenceExtreme: ref,
            lookback: PredicateEngine.Lookback.H1,
            timeframeSeconds: BUCKET
        });
    }

    function _bos(bool long_) internal pure returns (RefusalGate.PredicateDefinition memory) {
        return _pred(
            PredicateEngine.PredicateKind.BreakOfStructure,
            long_ ? PredicateEngine.Direction.Long : PredicateEngine.Direction.Short,
            PredicateEngine.ReferenceExtreme.PrevDayLow
        );
    }

    function _pin(RefusalGate.PredicateDefinition[] memory preds) internal returns (uint256 id) {
        vm.prank(owner);
        id = registry.pinStrategy{ value: 0.01 ether }(keccak256("spec"), keccak256(abi.encode(preds)), address(series));
    }

    function _arr1(RefusalGate.PredicateDefinition memory a) internal pure returns (RefusalGate.PredicateDefinition[] memory o) {
        o = new RefusalGate.PredicateDefinition[](1);
        o[0] = a;
    }

    function _rising() internal {
        _candle(0, 10_000);
        _candle(1, 10_100);
    }

    function _falling() internal {
        _candle(0, 10_000);
        _candle(1, 9_900);
    }

    // ---- the side mapping ---------------------------------------------

    function test_Mapping_BosAndFvg_FollowTheirDirection() public {
        TradeSideHarness h = new TradeSideHarness();
        PredicateEngine.PredicateKind[2] memory kinds =
            [PredicateEngine.PredicateKind.BreakOfStructure, PredicateEngine.PredicateKind.FairValueGap];
        for (uint256 k = 0; k < 2; k++) {
            (bool l, bool ok) = h.side(kinds[k], PredicateEngine.Direction.Long, PredicateEngine.ReferenceExtreme.PrevDayHigh);
            assertTrue(l);
            assertTrue(ok);
            (l, ok) = h.side(kinds[k], PredicateEngine.Direction.Short, PredicateEngine.ReferenceExtreme.PrevDayLow);
            assertFalse(l);
            assertTrue(ok);
        }
    }

    function test_Mapping_Sweep_IsFixedByTheReferenceExtreme() public {
        TradeSideHarness h = new TradeSideHarness();
        PredicateEngine.ReferenceExtreme[6] memory refs = [
            PredicateEngine.ReferenceExtreme.PrevDayLow,
            PredicateEngine.ReferenceExtreme.PrevDayHigh,
            PredicateEngine.ReferenceExtreme.PrevSessionLow,
            PredicateEngine.ReferenceExtreme.PrevSessionHigh,
            PredicateEngine.ReferenceExtreme.SwingLow,
            PredicateEngine.ReferenceExtreme.SwingHigh
        ];
        for (uint256 i = 0; i < 6; i++) {
            bool lowRef = i % 2 == 0; // Low, High, Low, High, Low, High
            // Committed direction that agrees with the reference: consistent.
            (bool l, bool ok) = h.side(
                PredicateEngine.PredicateKind.LiquiditySweep,
                lowRef ? PredicateEngine.Direction.Long : PredicateEngine.Direction.Short,
                refs[i]
            );
            assertEq(l, lowRef, "low reference => long setup, high reference => short setup");
            assertTrue(ok);
            // Contradicting direction: flagged inconsistent.
            (, ok) = h.side(
                PredicateEngine.PredicateKind.LiquiditySweep,
                lowRef ? PredicateEngine.Direction.Short : PredicateEngine.Direction.Long,
                refs[i]
            );
            assertFalse(ok);
        }
    }

    // ---- the gate -----------------------------------------------------

    function test_BullishRule_ApprovesLong_RefusesShort() public {
        RefusalGate.PredicateDefinition[] memory preds = _arr1(_bos(true));
        uint256 id = _pin(preds);
        _rising();

        vm.prank(proposer);
        assertTrue(gate.evaluateOnChain(id, true, preds));

        // The tape satisfies the bullish predicate, and the proposer asks for a short: refused.
        vm.expectEmit(true, true, true, true);
        emit TradeRefused(id, keccak256("spec"), proposer, "SIDE_MISMATCH", 1); // rule side: long
        vm.prank(proposer);
        assertFalse(gate.evaluateOnChain(id, false, preds));

        (bool ok, bytes32 sym, int256 v) = gate.previewOnChain(id, false, preds);
        assertFalse(ok);
        assertEq(sym, "SIDE_MISMATCH");
        assertEq(v, 1);
    }

    function test_BearishRule_ApprovesShort_RefusesLong() public {
        RefusalGate.PredicateDefinition[] memory preds = _arr1(_bos(false));
        uint256 id = _pin(preds);
        _falling(); // 9_900 < prior low 10_000: bearish BOS holds

        vm.prank(proposer);
        assertTrue(gate.evaluateOnChain(id, false, preds));

        vm.expectEmit(true, true, true, true);
        emit TradeRefused(id, keccak256("spec"), proposer, "SIDE_MISMATCH", 0); // rule side: short
        vm.prank(proposer);
        assertFalse(gate.evaluateOnChain(id, true, preds));
    }

    function test_SideMismatch_IsARefusalNotARevert_AndNeedsNoFreshSeries() public {
        RefusalGate.PredicateDefinition[] memory preds = _arr1(_bos(true));
        uint256 id = _pin(preds);
        // No candles at all: the series is stale, but a wrong-side trade is
        // refused on the committed rule alone.
        vm.prank(proposer);
        assertFalse(gate.evaluateOnChain(id, false, preds));
        // The right side still needs a fresh series.
        vm.prank(proposer);
        vm.expectRevert();
        gate.evaluateOnChain(id, true, preds);
    }

    function test_SweepRule_LowReference_IsLong_HighReference_IsShort() public {
        RefusalGate.PredicateDefinition[] memory lowSweep = _arr1(
            _pred(PredicateEngine.PredicateKind.LiquiditySweep, PredicateEngine.Direction.Long, PredicateEngine.ReferenceExtreme.SwingLow)
        );
        RefusalGate.PredicateDefinition[] memory highSweep = _arr1(
            _pred(PredicateEngine.PredicateKind.LiquiditySweep, PredicateEngine.Direction.Short, PredicateEngine.ReferenceExtreme.PrevDayHigh)
        );
        uint256 lowId = _pin(lowSweep);
        uint256 highId = _pin(highSweep);

        vm.prank(proposer);
        (bool ok, bytes32 sym,) = gate.previewOnChain(lowId, false, lowSweep);
        assertFalse(ok);
        assertEq(sym, "SIDE_MISMATCH");
        vm.prank(proposer);
        (ok, sym,) = gate.previewOnChain(highId, true, highSweep);
        assertFalse(ok);
        assertEq(sym, "SIDE_MISMATCH");
    }

    function test_SweepRule_ContradictoryDirectionReverts() public {
        // Low reference (a long setup) committed with direction Short.
        RefusalGate.PredicateDefinition[] memory bad = _arr1(
            _pred(PredicateEngine.PredicateKind.LiquiditySweep, PredicateEngine.Direction.Short, PredicateEngine.ReferenceExtreme.SwingLow)
        );
        uint256 id = _pin(bad);
        _rising();
        vm.prank(proposer);
        vm.expectRevert(abi.encodeWithSelector(RefusalGate.InconsistentSweepDirection.selector, 0));
        gate.evaluateOnChain(id, true, bad);
        vm.prank(proposer);
        vm.expectRevert(abi.encodeWithSelector(RefusalGate.InconsistentSweepDirection.selector, 0));
        gate.evaluateOnChain(id, false, bad);
    }

    function test_MixedDirections_Revert_ForEitherTradeSide() public {
        RefusalGate.PredicateDefinition[] memory mixed = new RefusalGate.PredicateDefinition[](2);
        mixed[0] = _bos(true);
        mixed[1] = _bos(false);
        uint256 id = _pin(mixed);
        _rising();
        vm.prank(proposer);
        vm.expectRevert(RefusalGate.MixedDirections.selector);
        gate.evaluateOnChain(id, true, mixed);
        vm.prank(proposer);
        vm.expectRevert(RefusalGate.MixedDirections.selector);
        gate.evaluateOnChain(id, false, mixed);
    }

    function test_MixedKinds_BullishBosPlusShortSetupSweep_Reverts() public {
        RefusalGate.PredicateDefinition[] memory mixed = new RefusalGate.PredicateDefinition[](2);
        mixed[0] = _bos(true);
        mixed[1] = _pred(
            PredicateEngine.PredicateKind.LiquiditySweep, PredicateEngine.Direction.Short, PredicateEngine.ReferenceExtreme.SwingHigh
        );
        uint256 id = _pin(mixed);
        _rising();
        vm.prank(proposer);
        vm.expectRevert(RefusalGate.MixedDirections.selector);
        gate.evaluateOnChain(id, true, mixed);
    }

    function test_AllBullishMixedKinds_AreOneRule() public {
        RefusalGate.PredicateDefinition[] memory preds = new RefusalGate.PredicateDefinition[](2);
        preds[0] = _bos(true);
        preds[1] = _pred(
            PredicateEngine.PredicateKind.LiquiditySweep, PredicateEngine.Direction.Long, PredicateEngine.ReferenceExtreme.SwingLow
        );
        uint256 id = _pin(preds);
        vm.prank(proposer);
        (bool ok, bytes32 sym,) = gate.previewOnChain(id, false, preds);
        assertFalse(ok);
        assertEq(sym, "SIDE_MISMATCH");
    }

    /// @notice Fuzz: for ANY committed predicate set, the gate never approves
    ///         a trade whose side differs from the side the set authorizes,
    ///         and never returns a result for a mixed/contradictory set.
    function testFuzz_NeverApprovesTheWrongSide(uint256 seed, bool isLong) public {
        uint256 n = 1 + (seed % 4);
        RefusalGate.PredicateDefinition[] memory preds = new RefusalGate.PredicateDefinition[](n);
        for (uint256 i = 0; i < n; i++) {
            uint256 r = uint256(keccak256(abi.encode(seed, i)));
            preds[i] = _pred(
                PredicateEngine.PredicateKind(uint8(r % 3)),
                PredicateEngine.Direction(uint8((r >> 8) % 2)),
                PredicateEngine.ReferenceExtreme(uint8((r >> 16) % 6))
            );
        }
        uint256 id = _pin(preds);
        _rising(); // fresh series so the matching-side path can run

        // Independent ghost of the rule's side.
        bool mixedOrBad;
        bool ruleLong;
        for (uint256 i = 0; i < n; i++) {
            bool l;
            if (preds[i].kind == PredicateEngine.PredicateKind.LiquiditySweep) {
                PredicateEngine.ReferenceExtreme e = preds[i].referenceExtreme;
                l = e == PredicateEngine.ReferenceExtreme.PrevDayLow || e == PredicateEngine.ReferenceExtreme.PrevSessionLow
                    || e == PredicateEngine.ReferenceExtreme.SwingLow;
                if ((preds[i].direction == PredicateEngine.Direction.Long) != l) mixedOrBad = true;
            } else {
                l = preds[i].direction == PredicateEngine.Direction.Long;
            }
            if (i == 0) ruleLong = l;
            else if (l != ruleLong) mixedOrBad = true;
        }

        vm.prank(proposer);
        try gate.previewOnChain(id, isLong, preds) returns (bool ok, bytes32 sym, int256) {
            assertFalse(mixedOrBad, "a mixed or contradictory rule must revert, never return");
            if (isLong != ruleLong) {
                assertFalse(ok, "approved the wrong side");
                assertEq(sym, "SIDE_MISMATCH");
            } else {
                assertTrue(sym != "SIDE_MISMATCH");
            }
        } catch {
            // Reverts are only allowed for a malformed rule, or (matching side)
            // for setup errors such as an unevaluable window that we do not model here.
            assertTrue(mixedOrBad || isLong == ruleLong);
        }
    }
}
