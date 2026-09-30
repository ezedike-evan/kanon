// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import { Test } from "forge-std/Test.sol";
import { StrategyRegistry } from "../src/StrategyRegistry.sol";
import { RefusalGate } from "../src/RefusalGate.sol";
import { CanonicalSeries } from "../src/CanonicalSeries.sol";
import { PredicateEngine } from "../src/PredicateEngine.sol";
import { GuardedVault } from "../src/GuardedVault.sol";
import { VaultFactory } from "../src/VaultFactory.sol";
import { MarginAccount } from "../src/MarginAccount.sol";
import { InsuranceFund } from "../src/InsuranceFund.sol";
import { MockPyth } from "./mocks/MockPyth.sol";
import { MockERC20 } from "./mocks/MockERC20.sol";
import { one } from "./helpers/GateFixture.sol";

contract RejectsEther {
    function pin(StrategyRegistry r, bytes32 h, bytes32 c, address s) external payable returns (uint256) {
        return r.pinStrategy{ value: msg.value }(h, c, s);
    }

    function request(StrategyRegistry r, uint256 id) external {
        r.requestRetire(id);
    }
}

contract StrategyRetireTest is Test {
    bytes32 constant FEED = bytes32(uint256(1));
    uint256 constant BUCKET = 900;
    uint256 constant COOLDOWN = 3 days;
    uint256 constant BOND = 0.05 ether;

    MockPyth pyth;
    CanonicalSeries series;
    StrategyRegistry registry;
    RefusalGate gate;
    uint256 id;
    address owner = address(0xA11CE);
    address rando = address(0xB0B);

    event RetireRequested(uint256 indexed strategyId, uint256 retireEndsAt);
    event RetireCancelled(uint256 indexed strategyId);
    event StrategyRetired(uint256 indexed strategyId, address indexed owner, uint256 bondRefunded);

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

    function _sample(int64 price) internal {
        pyth.setPrice(FEED, price, 1, -2, block.timestamp);
        series.recordSample();
    }

    function setUp() public {
        pyth = new MockPyth();
        series = new CanonicalSeries("BTC/USD", FEED, 1, BUCKET, address(pyth), 60);
        registry = new StrategyRegistry(0.01 ether, COOLDOWN, one(address(series)));
        gate = new RefusalGate(address(registry));
        vm.deal(owner, 1 ether);
        vm.prank(owner);
        id = registry.pinStrategy{ value: BOND }(keccak256("spec"), keccak256(abi.encode(_preds())), address(series));

        vm.warp(1_000_000 * BUCKET);
        _sample(10_000);
        vm.warp(1_000_001 * BUCKET);
        _sample(10_100);
    }

    function test_Gate_ApprovesBeforeRetire() public {
        assertTrue(gate.evaluateOnChain(id, true, _preds()));
    }

    function test_RequestRetire_OnlyOwner() public {
        vm.prank(rando);
        vm.expectRevert(StrategyRegistry.NotOwner.selector);
        registry.requestRetire(id);
    }

    function test_RequestRetire_EmitsAndStrategyStaysEnforcedDuringCooldown() public {
        vm.expectEmit(true, false, false, true);
        emit RetireRequested(id, block.timestamp + COOLDOWN);
        vm.prank(owner);
        registry.requestRetire(id);
        assertEq(registry.retireEndsAt(id), block.timestamp + COOLDOWN);
        assertFalse(registry.isRetired(id));
        // Still active: the gate still evaluates on the pinned rules.
        assertTrue(gate.evaluateOnChain(id, true, _preds()));
    }

    function test_RequestRetire_Twice_Reverts() public {
        vm.startPrank(owner);
        registry.requestRetire(id);
        vm.expectRevert(StrategyRegistry.RetireAlreadyRequested.selector);
        registry.requestRetire(id);
        vm.stopPrank();
    }

    function test_FinalizeRetire_WithoutRequest_Reverts() public {
        vm.expectRevert(StrategyRegistry.NoPendingRetire.selector);
        registry.finalizeRetire(id);
    }

    function test_Cooldown_CannotBeSkipped_ByAnyone() public {
        vm.prank(owner);
        registry.requestRetire(id);
        uint256 endsAt = registry.retireEndsAt(id);

        vm.expectRevert(abi.encodeWithSelector(StrategyRegistry.CoolingOff.selector, endsAt));
        registry.finalizeRetire(id);
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(StrategyRegistry.CoolingOff.selector, endsAt));
        registry.finalizeRetire(id);

        vm.warp(endsAt - 1);
        vm.expectRevert(abi.encodeWithSelector(StrategyRegistry.CoolingOff.selector, endsAt));
        registry.finalizeRetire(id);
    }

    function testFuzz_FinalizeRetire_RefundsExactBondToOwner_Permissionless(uint256 bond, address caller) public {
        bond = bound(bond, 0.01 ether, 100 ether);
        vm.assume(caller != address(registry));
        vm.deal(owner, bond);
        vm.prank(owner);
        uint256 id2 =
            registry.pinStrategy{ value: bond }(keccak256("s2"), keccak256("c2"), address(series));
        vm.prank(owner);
        registry.requestRetire(id2);
        vm.warp(registry.retireEndsAt(id2));

        uint256 ownerBefore = owner.balance;
        uint256 regBefore = address(registry).balance;
        vm.expectEmit(true, true, false, true);
        emit StrategyRetired(id2, owner, bond);
        vm.prank(caller);
        registry.finalizeRetire(id2);

        assertEq(owner.balance - ownerBefore, bond, "owner receives exactly the bond, never the caller");
        assertEq(regBefore - address(registry).balance, bond);
        assertTrue(registry.isRetired(id2));
        (, , uint256 storedBond,,,,,,,) = registry.strategies(id2);
        assertEq(storedBond, 0);
    }

    function test_FinalizeRetire_Twice_Reverts_NoDoubleRefund() public {
        vm.prank(owner);
        registry.requestRetire(id);
        vm.warp(registry.retireEndsAt(id));
        registry.finalizeRetire(id);
        uint256 bal = address(registry).balance;

        vm.expectRevert(StrategyRegistry.StrategyIsRetired.selector);
        registry.finalizeRetire(id);
        assertEq(address(registry).balance, bal);
    }

    function test_CancelRetire_KeepsStrategyAndBond() public {
        vm.startPrank(owner);
        registry.requestRetire(id);
        vm.expectEmit(true, false, false, true);
        emit RetireCancelled(id);
        registry.cancelRetire(id);
        vm.stopPrank();

        vm.warp(block.timestamp + COOLDOWN + 1);
        vm.expectRevert(StrategyRegistry.NoPendingRetire.selector);
        registry.finalizeRetire(id);
        assertFalse(registry.isRetired(id));
        assertEq(address(registry).balance, BOND);

        // And a fresh request is possible again.
        vm.prank(owner);
        registry.requestRetire(id);
    }

    function test_CancelRetire_OnlyOwner_AndNeedsPending() public {
        vm.prank(owner);
        vm.expectRevert(StrategyRegistry.NoPendingRetire.selector);
        registry.cancelRetire(id);
        vm.prank(owner);
        registry.requestRetire(id);
        vm.prank(rando);
        vm.expectRevert(StrategyRegistry.NotOwner.selector);
        registry.cancelRetire(id);
    }

    function test_AfterRetire_GateRefuses_FailClosed() public {
        vm.prank(owner);
        registry.requestRetire(id);
        vm.warp(registry.retireEndsAt(id));
        // Re-sample so the series is fresh; the ONLY thing that changed is the retire.
        _sample(10_200);
        registry.finalizeRetire(id);

        assertFalse(gate.evaluateOnChain(id, true, _preds()));
        (bool ok, bytes32 sym,) = gate.previewOnChain(id, true, _preds());
        assertFalse(ok);
        assertEq(sym, bytes32("RETIRED"));
    }

    function test_AfterRetire_NoFurtherMutation() public {
        vm.prank(owner);
        registry.requestRetire(id);
        vm.warp(registry.retireEndsAt(id));
        registry.finalizeRetire(id);

        vm.startPrank(owner);
        vm.expectRevert(StrategyRegistry.StrategyIsRetired.selector);
        registry.proposeLoosening(id, keccak256("a"), keccak256("b"), address(series));
        vm.expectRevert(StrategyRegistry.StrategyIsRetired.selector);
        registry.requestRetire(id);
        vm.stopPrank();
        vm.expectRevert(StrategyRegistry.StrategyIsRetired.selector);
        registry.finalizeLoosening(id);
    }

    function test_PendingLoosening_DoesNotResurrectRetiredStrategy() public {
        vm.startPrank(owner);
        registry.proposeLoosening(id, keccak256("a"), keccak256("b"), address(series));
        registry.requestRetire(id);
        vm.stopPrank();
        vm.warp(block.timestamp + COOLDOWN);
        registry.finalizeRetire(id);
        vm.expectRevert(StrategyRegistry.StrategyIsRetired.selector);
        registry.finalizeLoosening(id);
    }

    function test_AfterRetire_GuardedVaultRefusesTrades() public {
        MockERC20 usdc = new MockERC20("USD Coin", "USDC", 18);
        bytes32[] memory wl = new bytes32[](1);
        wl[0] = keccak256("BTC");
        GuardedVault vault = new GuardedVault(
            address(usdc), owner, address(0xE), address(registry), id, wl, 1_000, address(gate)
        );
        vm.prank(owner);
        assertTrue(vault.proposeTrade(keccak256("BTC"), true, 1, 0, _preds()));

        vm.prank(owner);
        registry.requestRetire(id);
        vm.warp(registry.retireEndsAt(id));
        _sample(10_300);
        registry.finalizeRetire(id);

        vm.prank(owner);
        assertFalse(vault.proposeTrade(keccak256("BTC"), true, 1, 0, _preds()));
    }

    function test_AfterRetire_FactoryAndMarginBindingRejectIt() public {
        MockERC20 usdc = new MockERC20("USD Coin", "USDC", 18);
        VaultFactory factory = new VaultFactory(address(usdc), address(registry), address(gate));
        address predicted = vm.computeCreateAddress(address(this), vm.getNonce(address(this)) + 1);
        InsuranceFund f = new InsuranceFund(address(usdc), predicted);
        MarginAccount m = new MarginAccount(address(usdc), 1000, address(f), 200, 1.2e18, 2_500, address(gate));

        vm.prank(owner);
        registry.requestRetire(id);
        vm.warp(registry.retireEndsAt(id));
        registry.finalizeRetire(id);

        bytes32[] memory wl = new bytes32[](1);
        wl[0] = keccak256("BTC");
        vm.prank(owner);
        vm.expectRevert(VaultFactory.StrategyRetired.selector);
        factory.createGuardedVault(address(0xE), id, wl, 1_000);
        vm.expectRevert(VaultFactory.StrategyRetired.selector);
        factory.createCopyVault(address(0xE), id, 5_000, 1_000, address(0xF));
        vm.prank(owner);
        vm.expectRevert(MarginAccount.StrategyRetired.selector);
        m.bindStrategy(id);
    }

    function test_Refund_ToContractThatRejectsEther_RevertsAndStaysActive() public {
        RejectsEther r = new RejectsEther();
        uint256 id2 = r.pin{ value: 0.02 ether }(registry, keccak256("s3"), keccak256("c3"), address(series));
        vm.deal(address(r), 0);
        r.request(registry, id2);
        vm.warp(registry.retireEndsAt(id2));
        vm.expectRevert(StrategyRegistry.RefundFailed.selector);
        registry.finalizeRetire(id2);
        assertFalse(registry.isRetired(id2), "failed refund leaves the strategy active");
    }
}
