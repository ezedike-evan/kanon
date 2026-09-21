// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import { Test } from "forge-std/Test.sol";
import { StrategyRegistry } from "../src/StrategyRegistry.sol";
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

        (address o, bytes32 h, uint256 bond,,,, bytes32 commitment, address series,,) = registry.strategies(id);
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
        vm.expectRevert(abi.encodeWithSelector(StrategyRegistry.SeriesNotCanonical.selector, address(0)));
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

    function test_Tighten_AppliesImmediately_AllThreeFields() public {
        uint256 id = _pin();
        vm.prank(owner);
        registry.tighten(id, HASH_C_TIGHTER, COMMIT_C_TIGHTER, SERIES_B);
        assertEq(registry.activeSpecHash(id), HASH_C_TIGHTER);
        assertEq(registry.activePredicatesCommitment(id), COMMIT_C_TIGHTER);
        assertEq(registry.activeSeries(id), SERIES_B);
    }

    function test_Tighten_RevertsForNonOwner() public {
        uint256 id = _pin();
        vm.expectRevert();
        registry.tighten(id, HASH_C_TIGHTER, COMMIT_C_TIGHTER, SERIES_A);
    }

    function test_Tighten_StillRejectsNonCanonicalSeries() public {
        uint256 id = _pin();
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(StrategyRegistry.SeriesNotCanonical.selector, ROGUE));
        registry.tighten(id, HASH_C_TIGHTER, COMMIT_C_TIGHTER, ROGUE);
    }

    function test_ProposeLoosening_DoesNotChangeAnyActiveFieldImmediately() public {
        uint256 id = _pin();
        vm.expectEmit(true, false, false, true);
        emit LooseningProposed(id, HASH_B_LOOSER, COMMIT_B_LOOSER, SERIES_B, block.timestamp + COOLDOWN);
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
        uint256 id = _pin();
        vm.startPrank(owner);
        registry.proposeLoosening(id, HASH_B_LOOSER, COMMIT_B_LOOSER, SERIES_B);
        registry.tighten(id, HASH_C_TIGHTER, COMMIT_C_TIGHTER, SERIES_A);
        vm.stopPrank();

        vm.warp(block.timestamp + COOLDOWN);
        vm.expectRevert();
        registry.finalizeLoosening(id);

        assertEq(registry.activeSpecHash(id), HASH_C_TIGHTER);
        assertEq(registry.activePredicatesCommitment(id), COMMIT_C_TIGHTER);
        (,,,, bytes32 pendingHash, uint256 cooldownEndsAt,,, bytes32 pendingCommit, address pendingSeries) =
            registry.strategies(id);
        assertEq(pendingHash, bytes32(0));
        assertEq(pendingCommit, bytes32(0));
        assertEq(pendingSeries, address(0));
        assertEq(cooldownEndsAt, 0);
    }
}
