// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import { Test } from "forge-std/Test.sol";
import { StrategyRegistry } from "../src/StrategyRegistry.sol";
import { CopyVault } from "../src/CopyVault.sol";
import { MockERC20 } from "./mocks/MockERC20.sol";
import { MockPyth } from "./mocks/MockPyth.sol";
import { CanonicalSeries } from "../src/CanonicalSeries.sol";
import { RefusalGate } from "../src/RefusalGate.sol";
import { PredicateEngine } from "../src/PredicateEngine.sol";
import { one } from "./helpers/GateFixture.sol";

contract CopyVaultTest is Test {
    bytes32 constant BTC = keccak256("BTC-USD");
    bytes32 constant ETH = keccak256("ETH-USD");

    uint256 constant ALLOCATION_BPS = 5_000; // follower mirrors 50% of leader size
    uint256 constant FEE_SHARE_BPS = 1_000; // 10% of realized profit only

    uint256 constant BUCKET = 900;
    uint256 constant BASE = 1_000_000;
    bytes32 constant FEED = bytes32(uint256(1));

    MockERC20 usdc;
    MockPyth pyth;
    CanonicalSeries series;
    StrategyRegistry registry;
    RefusalGate gate;
    CopyVault vault;

    address follower = address(0xA11CE);
    address leaderExecutor = address(0xDA1E);
    address feeRecipient = address(0xFEE0);
    address rando = address(0xB0B);

    event PositionMirrored(
        uint256 indexed positionId, bytes32 indexed assetId, bool isLong, uint256 followerSize, uint256 entryPrice
    );
    event PositionClosed(uint256 indexed positionId, uint256 exitPrice, int256 pnl, uint256 feeCharged);
    event FollowingToggled(bool active);
    event TradeSkipped(bytes32 indexed assetId, bytes32 reason);

    function setUp() public {
        usdc = new MockERC20("USD Coin", "USDC", 18);
        pyth = new MockPyth();
        series = new CanonicalSeries("BTC/USD", FEED, 1, BUCKET, address(pyth), 60);
        registry = new StrategyRegistry(0.01 ether, 3 days, one(address(series)));
        gate = new RefusalGate(address(registry));

        address leaderOwner = address(0x1EAD);
        vm.deal(leaderOwner, 1 ether);
        vm.prank(leaderOwner);
        uint256 leaderStrategyId = registry.pinStrategy{ value: 0.01 ether }(
            keccak256("leader-spec"), keccak256(abi.encode(_preds())), address(series)
        );

        // Two rising candles: the leader's bullish break of structure holds now.
        vm.warp(BASE * BUCKET);
        _sample(10_000);
        vm.warp((BASE + 1) * BUCKET);
        _sample(10_100);

        vault = new CopyVault(
            address(usdc),
            follower,
            leaderExecutor,
            address(registry),
            leaderStrategyId,
            ALLOCATION_BPS,
            FEE_SHARE_BPS,
            feeRecipient,
            address(gate)
        );

        usdc.mint(follower, 1_000);
        vm.prank(follower);
        usdc.approve(address(vault), type(uint256).max);
        vm.prank(follower);
        vault.deposit(1_000);
    }

    function _sample(int64 price) internal {
        pyth.setPrice(FEED, price, 1, -2, block.timestamp);
        series.recordSample();
    }

    function _preds() internal pure returns (RefusalGate.PredicateDefinition[] memory p) {
        p = new RefusalGate.PredicateDefinition[](1);
        p[0] = RefusalGate.PredicateDefinition({
            kind: PredicateEngine.PredicateKind.BreakOfStructure,
            symbol: "bos_bullish",
            direction: PredicateEngine.Direction.Long,
            swingLookbackCandles: 1,
            minGapBps: 0,
            referenceExtreme: PredicateEngine.ReferenceExtreme.PrevDayLow,
            lookback: PredicateEngine.Lookback.M15,
            timeframeSeconds: BUCKET
        });
    }

    /// @notice A leader's trade is mirrored only while the leader's OWN pinned
    ///         rules hold now; otherwise it is skipped (a success state, not
    ///         an error), and nothing is opened for the follower.
    function test_MirrorOpen_SkipsWhenTheLeadersPinnedPredicatesNoLongerHold() public {
        vm.warp(block.timestamp + BUCKET);
        _sample(10_050); // no longer breaks the previous high

        vm.expectEmit(true, false, false, true);
        emit TradeSkipped(BTC, "PREDICATE_NOT_SATISFIED");
        vm.prank(leaderExecutor);
        (bool mirrored,) = vault.mirrorOpen(BTC, true, 2_000, 100_000, _preds());

        assertFalse(mirrored);
        assertEq(vault.nextPositionId(), 0);
    }

    function test_MirrorOpen_SkipsAShortUnderALeaderWhoseRuleIsBullish() public {
        vm.expectEmit(true, false, false, true);
        emit TradeSkipped(BTC, "PREDICATE_NOT_SATISFIED");
        vm.prank(leaderExecutor);
        (bool mirrored,) = vault.mirrorOpen(BTC, false, 2_000, 100_000, _preds());
        assertFalse(mirrored);
        assertEq(vault.nextPositionId(), 0);
    }

    function test_MirrorOpen_RevertsWhenPredicatesAreNotTheLeadersCommittedOnes() public {
        RefusalGate.PredicateDefinition[] memory easier = _preds();
        easier[0].swingLookbackCandles = 2;
        vm.prank(leaderExecutor);
        vm.expectRevert();
        vault.mirrorOpen(BTC, true, 2_000, 100_000, easier);
    }

    function test_MirrorOpen_RevertsOnStaleSeries() public {
        vm.warp(block.timestamp + BUCKET); // nobody sampled the new bucket
        vm.prank(leaderExecutor);
        vm.expectRevert();
        vault.mirrorOpen(BTC, true, 2_000, 100_000, _preds());
    }

    function test_MirrorOpen_ScalesLeaderSizeByAllocationBps() public {
        vm.expectEmit(true, true, false, true);
        emit PositionMirrored(0, BTC, true, 1_000, 100_000);

        vm.prank(leaderExecutor);
        (bool mirrored, uint256 positionId) = vault.mirrorOpen(BTC, true, 2_000, 100_000, _preds());

        assertTrue(mirrored);
        assertEq(positionId, 0);
        (, , uint256 followerSize, uint256 entryPrice, bool open) = vault.positions(0);
        assertEq(followerSize, 1_000); // 2_000 * 50%
        assertEq(entryPrice, 100_000);
        assertTrue(open);
    }

    /// @notice Load-bearing: a profitable close charges exactly
    ///         `pnl * feeShareBps / 10_000` and credits the ledger with the
    ///         remainder — never the other way around.
    function test_MirrorClose_ChargesFeeOnlyOnProfit() public {
        vm.prank(leaderExecutor);
        (, uint256 positionId) = vault.mirrorOpen(BTC, true, 2_000, 100_000, _preds());
        // followerSize = 1_000, entry = 100_000

        // pnl = 1_000 * (110_000 - 100_000) / 100_000 = 100
        // fee = 100 * 10% = 10; net = 90
        vm.expectEmit(true, false, false, true);
        emit PositionClosed(positionId, 110_000, 100, 10);

        uint256 collateralBefore = vault.collateral();
        vm.prank(leaderExecutor);
        vault.mirrorClose(positionId, 110_000);

        assertEq(vault.collateral(), collateralBefore + 90);
        (, , , , bool open) = vault.positions(positionId);
        assertFalse(open);
    }

    /// @notice Load-bearing, the other half of the same guarantee: a losing
    ///         close charges NO fee at all — `feeCharged == 0` — and the full
    ///         loss (not loss-plus-fee) is debited from the ledger.
    function test_MirrorClose_ChargesNoFeeOnLoss() public {
        vm.prank(leaderExecutor);
        (, uint256 positionId) = vault.mirrorOpen(ETH, true, 2_000, 100_000, _preds());
        // followerSize = 1_000, entry = 100_000

        // pnl = 1_000 * (90_000 - 100_000) / 100_000 = -100
        vm.expectEmit(true, false, false, true);
        emit PositionClosed(positionId, 90_000, -100, 0);

        uint256 collateralBefore = vault.collateral();
        vm.prank(leaderExecutor);
        vault.mirrorClose(positionId, 90_000);

        assertEq(vault.collateral(), collateralBefore - 100, "full loss debited, no fee subtracted from it");
    }

    /// @notice Same profit/loss pair as above, chained on the same follower
    ///         ledger, proving the fee-only-on-profit math holds across
    ///         sequential trades, not just in isolation.
    function test_MirrorClose_ProfitThenLoss_LedgerMatchesExactArithmetic() public {
        vm.startPrank(leaderExecutor);
        (, uint256 winId) = vault.mirrorOpen(BTC, true, 2_000, 100_000, _preds());
        vault.mirrorClose(winId, 110_000); // +100 pnl, -10 fee -> +90
        (, uint256 lossId) = vault.mirrorOpen(ETH, true, 2_000, 100_000, _preds());
        vault.mirrorClose(lossId, 90_000); // -100 pnl, no fee -> -100
        vm.stopPrank();

        // 1_000 deposit + 90 net profit - 100 loss = 990
        assertEq(vault.collateral(), 990);
    }

    function test_SetActive_StopsNewMirroring_NoLockIn() public {
        vm.prank(follower);
        vault.setActive(false);
        assertFalse(vault.active());

        vm.expectEmit(true, false, false, true);
        emit TradeSkipped(BTC, "FOLLOWER_INACTIVE");

        vm.prank(leaderExecutor);
        (bool mirrored, uint256 positionId) = vault.mirrorOpen(BTC, true, 2_000, 100_000, _preds());
        assertFalse(mirrored);
        assertEq(positionId, 0);

        // Follower can re-enable at will — no admin, no cooldown.
        vm.prank(follower);
        vault.setActive(true);
        vm.prank(leaderExecutor);
        (mirrored,) = vault.mirrorOpen(BTC, true, 2_000, 100_000, _preds());
        assertTrue(mirrored);
    }

    function test_Withdraw_OnlyFollowerAndBoundedByLedger() public {
        vm.prank(follower);
        vault.withdraw(400);
        assertEq(vault.collateral(), 600);
        assertEq(usdc.balanceOf(follower), 400);
    }

    /// @notice No-backdoor: nobody but the follower controls their own funds
    ///         or kill switch, and nobody but leaderExecutor can mirror a
    ///         trade into the follower's ledger.
    function test_NoBackdoor_RandomAddressCannotTouchFollowerFundsOrMirrorTrades() public {
        vm.prank(rando);
        vm.expectRevert();
        vault.withdraw(1);

        vm.prank(rando);
        vm.expectRevert();
        vault.setActive(false);

        vm.prank(rando);
        vm.expectRevert();
        vault.mirrorOpen(BTC, true, 1_000, 100_000, _preds());

        vm.prank(follower);
        vm.expectRevert();
        vault.mirrorOpen(BTC, true, 1_000, 100_000, _preds()); // even the follower can't self-mirror

        vm.prank(rando);
        vm.expectRevert();
        vault.deposit(1); // deposits are follower-only too
    }
}
