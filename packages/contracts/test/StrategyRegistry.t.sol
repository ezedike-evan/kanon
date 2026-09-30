// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import { Test } from "forge-std/Test.sol";
import { StrategyRegistry } from "../src/StrategyRegistry.sol";
import { PredicateEngine } from "../src/PredicateEngine.sol";
import { one } from "./helpers/GateFixture.sol";

contract StrategyRegistryTest is Test {
    uint256 constant MIN_BOND = 0.01 ether;
    uint256 constant COOLDOWN = 3 days;

    StrategyRegistry registry;
    address owner = address(0xA11CE);

    address constant SERIES_A = address(0x5E11E5A);
    address constant SERIES_B = address(0x5E11E5B);
    address constant ROGUE = address(0xBADBAD);

    bytes32 constant HASH_A = keccak256("spec-a");
    bytes32 constant HASH_B_LOOSER = keccak256("spec-b-looser");
    bytes32 constant HASH_C_TIGHTER = keccak256("spec-c-tighter");
    bytes32 constant COMMIT_A = keccak256("commit-a");
    bytes32 constant COMMIT_B_LOOSER = keccak256("commit-b-looser");
    bytes32 constant COMMIT_C_TIGHTER = keccak256("commit-c-tighter");

    event StrategyPinned(
        uint256 indexed strategyId,
        address indexed owner,
        bytes32 specHash,
        uint256 bond,
        bytes32 predicatesCommitment,
        address series
    );
    event LooseningProposed(
        uint256 indexed strategyId,
        bytes32 pendingSpecHash,
        bytes32 pendingPredicatesCommitment,
        address pendingSeries,
        uint256 cooldownEndsAt
    );

    function setUp() public {
        address[] memory canonical = new address[](2);
        canonical[0] = SERIES_A;
        canonical[1] = SERIES_B;
        registry = new StrategyRegistry(MIN_BOND, COOLDOWN, canonical);
        vm.deal(owner, 10 ether);
    }

    function _pin() internal returns (uint256 strategyId) {
        vm.prank(owner);
        strategyId = registry.pinStrategy{ value: MIN_BOND }(HASH_A, COMMIT_A, SERIES_A);
    }

    function test_PinStrategy_RevertsBelowMinBond() public {
        vm.prank(owner);
        vm.expectRevert();
        registry.pinStrategy{ value: MIN_BOND - 1 }(HASH_A, COMMIT_A, SERIES_A);
    }

    function test_PinStrategy_StoresOwnerHashBondCommitmentAndSeries() public {
        vm.expectEmit(true, true, false, true);
        emit StrategyPinned(0, owner, HASH_A, MIN_BOND, COMMIT_A, SERIES_A);
        uint256 id = _pin();

        (address o, bytes32 h, uint256 bond,,,, bytes32 commitment, address series,,) =
            registry.strategies(id);
        assertEq(o, owner);
        assertEq(h, HASH_A);
        assertEq(bond, MIN_BOND);
        assertEq(commitment, COMMIT_A);
        assertEq(series, SERIES_A);
        assertEq(registry.activePredicatesCommitment(id), COMMIT_A);
        assertEq(registry.activeSeries(id), SERIES_A);
        assertEq(registry.ownerOf(id), owner);
    }

    function test_PinStrategy_RejectsNonCanonicalSeries() public {
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(StrategyRegistry.SeriesNotCanonical.selector, ROGUE));
        registry.pinStrategy{ value: MIN_BOND }(HASH_A, COMMIT_A, ROGUE);

        vm.prank(owner);
        vm.expectRevert(
            abi.encodeWithSelector(StrategyRegistry.SeriesNotCanonical.selector, address(0))
        );
        registry.pinStrategy{ value: MIN_BOND }(HASH_A, COMMIT_A, address(0));
    }

    function test_PinStrategy_RejectsEmptyHashOrCommitment() public {
        vm.prank(owner);
        vm.expectRevert(StrategyRegistry.EmptySpecHash.selector);
        registry.pinStrategy{ value: MIN_BOND }(bytes32(0), COMMIT_A, SERIES_A);

        vm.prank(owner);
        vm.expectRevert(StrategyRegistry.EmptyCommitment.selector);
        registry.pinStrategy{ value: MIN_BOND }(HASH_A, bytes32(0), SERIES_A);
    }

    function test_Constructor_RequiresCanonicalSeries() public {
        vm.expectRevert("series required");
        new StrategyRegistry(MIN_BOND, COOLDOWN, new address[](0));
        vm.expectRevert("series required");
        new StrategyRegistry(MIN_BOND, COOLDOWN, one(address(0)));
        vm.expectRevert("cooldown required");
        new StrategyRegistry(MIN_BOND, 0, one(SERIES_A));
    }

    function test_CanonicalSeriesList() public view {
        address[] memory list = registry.canonicalSeries();
        assertEq(list.length, 2);
        assertTrue(registry.isCanonicalSeries(SERIES_A));
        assertFalse(registry.isCanonicalSeries(ROGUE));
    }

    // ---- tighten: on-chain partial order ----

    function _p(uint256 minGap, uint256 lookback, PredicateEngine.Lookback lb)
        internal
        pure
        returns (StrategyRegistry.PredicateDefinition memory)
    {
        return StrategyRegistry.PredicateDefinition({
            kind: PredicateEngine.PredicateKind.FairValueGap,
            symbol: bytes32("BTC"),
            direction: PredicateEngine.Direction.Long,
            swingLookbackCandles: lookback,
            minGapBps: minGap,
            referenceExtreme: PredicateEngine.ReferenceExtreme.SwingLow,
            lookback: lb,
            timeframeSeconds: 900
        });
    }

    function _base() internal pure returns (StrategyRegistry.PredicateDefinition[] memory a) {
        a = new StrategyRegistry.PredicateDefinition[](2);
        a[0] = _p(50, 10, PredicateEngine.Lookback.H1);
        a[1] = _p(20, 5, PredicateEngine.Lookback.H4);
    }

    function _c(StrategyRegistry.PredicateDefinition[] memory a) internal pure returns (bytes32) {
        return keccak256(abi.encode(a));
    }

    function _pinPreds(StrategyRegistry.PredicateDefinition[] memory a)
        internal
        returns (uint256 id)
    {
        vm.prank(owner);
        id = registry.pinStrategy{ value: MIN_BOND }(HASH_A, _c(a), SERIES_A);
    }

    function _tighten(
        uint256 id,
        StrategyRegistry.PredicateDefinition[] memory o,
        StrategyRegistry.PredicateDefinition[] memory n,
        address series
    ) internal {
        vm.prank(owner);
        registry.tighten(id, HASH_C_TIGHTER, _c(n), series, o, n);
    }

    function test_MirrorStructEncodesLikeRefusalGate() public pure {
        // Layout equality: the mirror's abi.encode must equal RefusalGate's for the same values.
        // RefusalGate.t.sol's _reg() round-trips through abi.decode; here we pin the head layout.
        StrategyRegistry.PredicateDefinition[] memory a = _base();
        bytes memory enc = abi.encode(a);
        // offset, length, then 8 static words per element
        assertEq(enc.length, 32 * (2 + 8 * 2));
    }

    function test_Tighten_RaisingMinGapBps_Accepted() public {
        StrategyRegistry.PredicateDefinition[] memory o = _base();
        uint256 id = _pinPreds(o);
        StrategyRegistry.PredicateDefinition[] memory n = _base();
        n[0].minGapBps = 80;
        _tighten(id, o, n, SERIES_A);
        assertEq(registry.activeSpecHash(id), HASH_C_TIGHTER);
        assertEq(registry.activePredicatesCommitment(id), _c(n));
        assertEq(registry.activeSeries(id), SERIES_A);
    }

    function test_Tighten_EqualPredicates_Accepted() public {
        StrategyRegistry.PredicateDefinition[] memory o = _base();
        uint256 id = _pinPreds(o);
        _tighten(id, o, o, SERIES_A);
        assertEq(registry.activeSpecHash(id), HASH_C_TIGHTER);
    }

    function test_Tighten_AppendedPredicate_Accepted() public {
        StrategyRegistry.PredicateDefinition[] memory o = _base();
        uint256 id = _pinPreds(o);
        StrategyRegistry.PredicateDefinition[] memory n =
            new StrategyRegistry.PredicateDefinition[](3);
        n[0] = o[0];
        n[1] = o[1];
        n[2] = _p(10, 3, PredicateEngine.Lookback.D1);
        _tighten(id, o, n, SERIES_A);
        assertEq(registry.activePredicatesCommitment(id), _c(n));
    }

    function test_Tighten_LoweredMinGapBps_Rejected() public {
        StrategyRegistry.PredicateDefinition[] memory o = _base();
        uint256 id = _pinPreds(o);
        StrategyRegistry.PredicateDefinition[] memory n = _base();
        n[1].minGapBps = 19;
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(StrategyRegistry.NotATightening.selector, 1));
        registry.tighten(id, HASH_C_TIGHTER, _c(n), SERIES_A, o, n);
    }

    function test_Tighten_ChangedLookback_Rejected() public {
        StrategyRegistry.PredicateDefinition[] memory o = _base();
        uint256 id = _pinPreds(o);
        StrategyRegistry.PredicateDefinition[] memory n = _base();
        n[0].lookback = PredicateEngine.Lookback.D1;
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(StrategyRegistry.NotATightening.selector, 0));
        registry.tighten(id, HASH_C_TIGHTER, _c(n), SERIES_A, o, n);
    }

    function test_Tighten_ChangedSwingLookbackCandles_Rejected() public {
        StrategyRegistry.PredicateDefinition[] memory o = _base();
        uint256 id = _pinPreds(o);
        StrategyRegistry.PredicateDefinition[] memory n = _base();
        n[0].swingLookbackCandles = 11;
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(StrategyRegistry.NotATightening.selector, 0));
        registry.tighten(id, HASH_C_TIGHTER, _c(n), SERIES_A, o, n);
    }

    function test_Tighten_RemovedPredicate_Rejected() public {
        StrategyRegistry.PredicateDefinition[] memory o = _base();
        uint256 id = _pinPreds(o);
        StrategyRegistry.PredicateDefinition[] memory n =
            new StrategyRegistry.PredicateDefinition[](1);
        n[0] = o[0];
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(StrategyRegistry.NotATightening.selector, 2));
        registry.tighten(id, HASH_C_TIGHTER, _c(n), SERIES_A, o, n);
    }

    function test_Tighten_Reordered_Rejected() public {
        StrategyRegistry.PredicateDefinition[] memory o = _base();
        uint256 id = _pinPreds(o);
        StrategyRegistry.PredicateDefinition[] memory n =
            new StrategyRegistry.PredicateDefinition[](2);
        n[0] = o[1];
        n[1] = o[0];
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(StrategyRegistry.NotATightening.selector, 0));
        registry.tighten(id, HASH_C_TIGHTER, _c(n), SERIES_A, o, n);
    }

    function test_Tighten_WrongOldPredicates_Rejected() public {
        StrategyRegistry.PredicateDefinition[] memory o = _base();
        uint256 id = _pinPreds(o);
        // Caller lies about the pinned rule: claims an easier "old" so a looser "new" looks like a raise.
        StrategyRegistry.PredicateDefinition[] memory fakeOld = _base();
        fakeOld[0].minGapBps = 1;
        StrategyRegistry.PredicateDefinition[] memory n = _base();
        n[0].minGapBps = 2;
        vm.prank(owner);
        vm.expectRevert(StrategyRegistry.OldPredicatesMismatch.selector);
        registry.tighten(id, HASH_C_TIGHTER, _c(n), SERIES_A, fakeOld, n);
    }

    function test_Tighten_NewCommitmentMismatch_Rejected() public {
        StrategyRegistry.PredicateDefinition[] memory o = _base();
        uint256 id = _pinPreds(o);
        StrategyRegistry.PredicateDefinition[] memory n = _base();
        n[0].minGapBps = 80;
        vm.prank(owner);
        vm.expectRevert(StrategyRegistry.NewPredicatesMismatch.selector);
        registry.tighten(id, HASH_C_TIGHTER, COMMIT_C_TIGHTER, SERIES_A, o, n);
    }

    function test_Tighten_SeriesChange_Rejected() public {
        StrategyRegistry.PredicateDefinition[] memory o = _base();
        uint256 id = _pinPreds(o);
        vm.prank(owner);
        vm.expectRevert(StrategyRegistry.SeriesChangeIsLoosening.selector);
        registry.tighten(id, HASH_C_TIGHTER, _c(o), SERIES_B, o, o);
    }

    function test_Tighten_RevertsForNonOwner() public {
        StrategyRegistry.PredicateDefinition[] memory o = _base();
        uint256 id = _pinPreds(o);
        vm.expectRevert(StrategyRegistry.NotOwner.selector);
        registry.tighten(id, HASH_C_TIGHTER, _c(o), SERIES_A, o, o);
    }

    function test_Tighten_StillRejectsNonCanonicalSeries() public {
        StrategyRegistry.PredicateDefinition[] memory o = _base();
        uint256 id = _pinPreds(o);
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(StrategyRegistry.SeriesNotCanonical.selector, ROGUE));
        registry.tighten(id, HASH_C_TIGHTER, _c(o), ROGUE, o, o);
    }

    function test_LooseningOfPredicates_StillWaitsCooldown() public {
        StrategyRegistry.PredicateDefinition[] memory o = _base();
        uint256 id = _pinPreds(o);
        StrategyRegistry.PredicateDefinition[] memory n = _base();
        n[0].minGapBps = 1;
        vm.prank(owner);
        registry.proposeLoosening(id, HASH_B_LOOSER, _c(n), SERIES_A);
        assertEq(registry.activePredicatesCommitment(id), _c(o));
        vm.warp(block.timestamp + COOLDOWN - 1);
        vm.expectRevert();
        registry.finalizeLoosening(id);
        vm.warp(block.timestamp + 1);
        registry.finalizeLoosening(id);
        assertEq(registry.activePredicatesCommitment(id), _c(n));
    }

    function test_ProposeLoosening_DoesNotChangeAnyActiveFieldImmediately() public {
        uint256 id = _pin();
        vm.expectEmit(true, false, false, true);
        emit LooseningProposed(
            id, HASH_B_LOOSER, COMMIT_B_LOOSER, SERIES_B, block.timestamp + COOLDOWN
        );
        vm.prank(owner);
        registry.proposeLoosening(id, HASH_B_LOOSER, COMMIT_B_LOOSER, SERIES_B);

        // A loosening — including a new predicates commitment or a new series —
        // never applies until the cooldown has fully elapsed.
        assertEq(registry.activeSpecHash(id), HASH_A);
        assertEq(registry.activePredicatesCommitment(id), COMMIT_A);
        assertEq(registry.activeSeries(id), SERIES_A);
    }

    /// @notice The load-bearing test: finalizing before the cooldown ends must
    ///         revert, for anyone, with no override path.
    function test_FinalizeLoosening_RevertsBeforeCooldownEnds() public {
        uint256 id = _pin();
        vm.prank(owner);
        registry.proposeLoosening(id, HASH_B_LOOSER, COMMIT_B_LOOSER, SERIES_B);

        vm.warp(block.timestamp + COOLDOWN - 1);
        vm.expectRevert();
        registry.finalizeLoosening(id);

        // Even the owner cannot skip the cooldown.
        vm.prank(owner);
        vm.expectRevert();
        registry.finalizeLoosening(id);

        assertEq(registry.activeSpecHash(id), HASH_A);
        assertEq(registry.activePredicatesCommitment(id), COMMIT_A);
    }

    function test_FinalizeLoosening_SucceedsAfterCooldownAndIsPermissionless() public {
        uint256 id = _pin();
        vm.prank(owner);
        registry.proposeLoosening(id, HASH_B_LOOSER, COMMIT_B_LOOSER, SERIES_B);

        vm.warp(block.timestamp + COOLDOWN);

        // Called by a random address, not the owner — permissionless finalize.
        address rando = address(0xB0B);
        vm.prank(rando);
        registry.finalizeLoosening(id);

        assertEq(registry.activeSpecHash(id), HASH_B_LOOSER);
        assertEq(registry.activePredicatesCommitment(id), COMMIT_B_LOOSER);
        assertEq(registry.activeSeries(id), SERIES_B);
    }

    function test_ProposeLoosening_ValidatesLikeAnyOtherSpecChange() public {
        uint256 id = _pin();
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(StrategyRegistry.SeriesNotCanonical.selector, ROGUE));
        registry.proposeLoosening(id, HASH_B_LOOSER, COMMIT_B_LOOSER, ROGUE);
        vm.prank(owner);
        vm.expectRevert(StrategyRegistry.EmptyCommitment.selector);
        registry.proposeLoosening(id, HASH_B_LOOSER, bytes32(0), SERIES_A);
    }

    function test_FinalizeLoosening_RevertsWithNoPendingProposal() public {
        uint256 id = _pin();
        vm.expectRevert();
        registry.finalizeLoosening(id);
    }

    function test_Tighten_CancelsInFlightLooseningProposal_IncludingItsCommitment() public {
        StrategyRegistry.PredicateDefinition[] memory o = _base();
        StrategyRegistry.PredicateDefinition[] memory n = _base();
        n[0].minGapBps = 80;
        uint256 id = _pinPreds(o);
        vm.startPrank(owner);
        registry.proposeLoosening(id, HASH_B_LOOSER, COMMIT_B_LOOSER, SERIES_B);
        registry.tighten(id, HASH_C_TIGHTER, _c(n), SERIES_A, o, n);
        vm.stopPrank();

        vm.warp(block.timestamp + COOLDOWN);
        vm.expectRevert();
        registry.finalizeLoosening(id);

        assertEq(registry.activeSpecHash(id), HASH_C_TIGHTER);
        assertEq(registry.activePredicatesCommitment(id), _c(n));
        (
            ,,,,
            bytes32 pendingHash,
            uint256 cooldownEndsAt,,,
            bytes32 pendingCommit,
            address pendingSeries
        ) = registry.strategies(id);
        assertEq(pendingHash, bytes32(0));
        assertEq(pendingCommit, bytes32(0));
        assertEq(pendingSeries, address(0));
        assertEq(cooldownEndsAt, 0);
    }
}
