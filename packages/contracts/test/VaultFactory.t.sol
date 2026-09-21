// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import { Test, Vm } from "forge-std/Test.sol";
import { VaultFactory } from "../src/VaultFactory.sol";
import { GuardedVault } from "../src/GuardedVault.sol";
import { CopyVault } from "../src/CopyVault.sol";
import { StrategyRegistry } from "../src/StrategyRegistry.sol";
import { RefusalGate } from "../src/RefusalGate.sol";
import { CanonicalSeries } from "../src/CanonicalSeries.sol";
import { MockERC20 } from "./mocks/MockERC20.sol";
import { MockPyth } from "./mocks/MockPyth.sol";
import { two } from "./helpers/GateFixture.sol";

contract VaultFactoryTest is Test {
    bytes32 constant BTC = keccak256("BTC-USD");
    bytes32 constant ETH = keccak256("ETH-USD");

    MockERC20 usdc;
    MockPyth pyth;
    CanonicalSeries btcSeries;
    CanonicalSeries ethSeries;
    CanonicalSeries rogueSeries;
    bytes32 constant COMMIT = keccak256("commitment");
    StrategyRegistry registry;
    RefusalGate gate;
    VaultFactory factory;

    address alice = address(0xA11CE);
    address bob = address(0xB0B);
    address executor = address(0xEEEE);
    address feeRecipient = address(0xFEE);

    uint256 aliceStrategy;

    event GuardedVaultCreated(
        address indexed vault,
        address indexed owner,
        uint256 indexed strategyId,
        address strategyExecutor,
        address series,
        uint256 maxDailyDrawdownBps,
        bytes32[] whitelistedAssetIds
    );
    event CopyVaultCreated(
        address indexed vault,
        address indexed follower,
        uint256 indexed leaderStrategyId,
        address leaderExecutor,
        uint256 allocationBps,
        uint256 feeShareBps,
        address feeRecipient
    );

    function setUp() public {
        usdc = new MockERC20("USD Coin", "USDC", 18);
        pyth = new MockPyth();
        btcSeries = new CanonicalSeries("BTC/USD", bytes32(uint256(1)), 60, 900, address(pyth), 60);
        ethSeries = new CanonicalSeries("ETH/USD", bytes32(uint256(2)), 60, 900, address(pyth), 60);
        rogueSeries = new CanonicalSeries("ROGUE/USD", bytes32(uint256(3)), 60, 900, address(pyth), 60);
        registry = new StrategyRegistry(0.01 ether, 1 days, two(address(btcSeries), address(ethSeries)));
        gate = new RefusalGate(address(registry));
        factory = new VaultFactory(address(usdc), address(registry), address(gate));

        vm.deal(alice, 1 ether);
        vm.deal(bob, 1 ether);
        vm.prank(alice);
        aliceStrategy = registry.pinStrategy{ value: 0.01 ether }(keccak256("alice-spec"), COMMIT, address(btcSeries));
    }

    function _whitelist() internal pure returns (bytes32[] memory w) {
        w = new bytes32[](2);
        w[0] = BTC;
        w[1] = ETH;
    }

    function _createGuarded() internal returns (GuardedVault v) {
        vm.prank(alice);
        v = GuardedVault(factory.createGuardedVault(executor, aliceStrategy, _whitelist(), 1_000));
    }

    // ------------------------------------------------------------------
    // GuardedVault
    // ------------------------------------------------------------------

    function test_CreateGuardedVault_WiresEverythingAndRegisters() public {
        GuardedVault v = _createGuarded();

        assertEq(v.owner(), alice);
        assertEq(v.strategyExecutor(), executor);
        assertEq(address(v.collateralToken()), address(usdc));
        assertEq(address(v.registry()), address(registry));
        assertEq(address(v.refusalGate()), address(gate));
        assertEq(registry.activeSeries(v.strategyId()), address(btcSeries)); // the series is the strategy's, not a vault parameter
        assertEq(v.strategyId(), aliceStrategy);
        assertEq(v.maxDailyDrawdownBps(), 1_000);
        assertTrue(v.isWhitelisted(BTC));
        assertTrue(v.isWhitelisted(ETH));

        assertTrue(factory.isVault(address(v)));
        assertTrue(factory.isGuardedVault(address(v)));
        assertFalse(factory.isCopyVault(address(v)));
        assertEq(factory.guardedVaultCount(), 1);
        assertEq(factory.guardedVaultAt(0), address(v));
        assertEq(factory.guardedVaultsOf(alice).length, 1);
        assertEq(factory.guardedVaultsOf(alice)[0], address(v));
        assertEq(factory.guardedVaultsOf(bob).length, 0);
    }

    function test_CreateGuardedVault_EmitsEventWithNewAddress() public {
        // The vault address is not known before creation; check the topics we can
        // (owner, strategy) and the data via a recorded-logs pass instead.
        vm.recordLogs();
        GuardedVault v = _createGuarded();
        Vm.Log[] memory logs = vm.getRecordedLogs();

        bool found;
        for (uint256 i = 0; i < logs.length; i++) {
            if (logs[i].emitter == address(factory) && logs[i].topics[0] == GuardedVaultCreated.selector) {
                found = true;
                assertEq(address(uint160(uint256(logs[i].topics[1]))), address(v));
                assertEq(address(uint160(uint256(logs[i].topics[2]))), alice);
                assertEq(uint256(logs[i].topics[3]), aliceStrategy);
                (address ex, address series, uint256 dd, bytes32[] memory wl) =
                    abi.decode(logs[i].data, (address, address, uint256, bytes32[]));
                assertEq(ex, executor);
                assertEq(series, address(btcSeries));
                assertEq(dd, 1_000);
                assertEq(wl.length, 2);
            }
        }
        assertTrue(found, "GuardedVaultCreated not emitted");
    }

    function test_CreateGuardedVault_CallerMustOwnTheStrategy() public {
        vm.prank(bob);
        vm.expectRevert(VaultFactory.NotStrategyOwner.selector);
        factory.createGuardedVault(executor, aliceStrategy, _whitelist(), 1_000);
    }

    function test_CreateGuardedVault_UnknownStrategyReverts() public {
        vm.prank(alice);
        vm.expectRevert(VaultFactory.UnknownStrategy.selector);
        factory.createGuardedVault(executor, 999, _whitelist(), 1_000);
    }

    function test_CreateGuardedVault_PropagatesVaultValidation() public {
        vm.prank(alice);
        vm.expectRevert(GuardedVault.InvalidDrawdownBps.selector);
        factory.createGuardedVault(executor, aliceStrategy, _whitelist(), 0);

        vm.prank(alice);
        vm.expectRevert(GuardedVault.EmptyWhitelist.selector);
        factory.createGuardedVault(executor, aliceStrategy, new bytes32[](0), 1_000);
    }

    function test_CreateGuardedVault_ManyPerOwner_AllDistinct() public {
        vm.startPrank(alice);
        address v1 = factory.createGuardedVault(executor, aliceStrategy, _whitelist(), 1_000);
        address v2 = factory.createGuardedVault(executor, aliceStrategy, _whitelist(), 500);
        vm.stopPrank();
        assertTrue(v1 != v2);
        assertEq(factory.guardedVaultsOf(alice).length, 2);
        assertEq(factory.guardedVaultCount(), 2);
    }

    /// @notice The created vault is fully functional and only its owner can
    ///         withdraw: deposit through it, then check a stranger cannot.
    function test_CreatedGuardedVault_OnlyOwnerWithdraws() public {
        GuardedVault v = _createGuarded();
        usdc.mint(alice, 1_000);
        vm.startPrank(alice);
        usdc.approve(address(v), 1_000);
        v.deposit(1_000);
        vm.stopPrank();

        vm.prank(bob);
        vm.expectRevert(GuardedVault.NotAuthorized.selector);
        v.withdraw(1);

        vm.prank(executor);
        vm.expectRevert(GuardedVault.NotAuthorized.selector);
        v.withdraw(1);

        vm.prank(alice);
        v.withdraw(1_000);
        assertEq(usdc.balanceOf(alice), 1_000);
    }

    // ------------------------------------------------------------------
    // CopyVault
    // ------------------------------------------------------------------

    function test_CreateCopyVault_WiresEverythingAndRegisters() public {
        vm.prank(bob);
        CopyVault v = CopyVault(factory.createCopyVault(executor, aliceStrategy, 2_500, 1_000, feeRecipient));

        assertEq(v.follower(), bob);
        assertEq(v.leaderExecutor(), executor);
        assertEq(address(v.collateralToken()), address(usdc));
        assertEq(address(v.registry()), address(registry));
        assertEq(v.leaderStrategyId(), aliceStrategy);
        assertEq(v.allocationBps(), 2_500);
        assertEq(v.feeShareBps(), 1_000);
        assertEq(v.feeRecipient(), feeRecipient);

        assertTrue(factory.isVault(address(v)));
        assertTrue(factory.isCopyVault(address(v)));
        assertFalse(factory.isGuardedVault(address(v)));
        assertEq(factory.copyVaultCount(), 1);
        assertEq(factory.copyVaultAt(0), address(v));
        assertEq(factory.copyVaultsOf(bob)[0], address(v));
        assertEq(factory.copyVaultsOf(alice).length, 0);
    }

    function test_CreateCopyVault_EmitsEvent() public {
        vm.recordLogs();
        vm.prank(bob);
        address v = factory.createCopyVault(executor, aliceStrategy, 2_500, 1_000, feeRecipient);
        Vm.Log[] memory logs = vm.getRecordedLogs();

        bool found;
        for (uint256 i = 0; i < logs.length; i++) {
            if (logs[i].emitter == address(factory) && logs[i].topics[0] == CopyVaultCreated.selector) {
                found = true;
                assertEq(address(uint160(uint256(logs[i].topics[1]))), v);
                assertEq(address(uint160(uint256(logs[i].topics[2]))), bob);
                assertEq(uint256(logs[i].topics[3]), aliceStrategy);
                (address ex, uint256 alloc, uint256 fee, address recipient) =
                    abi.decode(logs[i].data, (address, uint256, uint256, address));
                assertEq(ex, executor);
                assertEq(alloc, 2_500);
                assertEq(fee, 1_000);
                assertEq(recipient, feeRecipient);
            }
        }
        assertTrue(found, "CopyVaultCreated not emitted");
    }

    function test_CreateCopyVault_UnknownLeaderStrategyReverts() public {
        vm.prank(bob);
        vm.expectRevert(VaultFactory.UnknownStrategy.selector);
        factory.createCopyVault(executor, 42, 2_500, 1_000, feeRecipient);
    }

    function test_CreateCopyVault_PropagatesVaultValidation() public {
        vm.prank(bob);
        vm.expectRevert("invalid allocation bps");
        factory.createCopyVault(executor, aliceStrategy, 0, 1_000, feeRecipient);
    }

    // ------------------------------------------------------------------
    // Verification: only the factory's own vaults are recognized
    // ------------------------------------------------------------------

    function test_IsVault_FalseForLookalikeDeployedElsewhere() public {
        bytes32[] memory w = _whitelist();
        // Same constructor args, deployed directly, not through the factory.
        GuardedVault lookalike = new GuardedVault(
            address(usdc),
            alice,
            executor,
            address(registry),
            aliceStrategy,
            w,
            1_000,
            address(gate)
        );
        assertFalse(factory.isVault(address(lookalike)));
        assertEq(uint256(factory.vaultKindOf(address(lookalike))), uint256(VaultFactory.VaultKind.None));
        assertFalse(factory.isVault(address(0)));
        assertFalse(factory.isVault(alice));
    }

    function test_Constructor_Validates() public {
        vm.expectRevert("collateral token required");
        new VaultFactory(address(0), address(registry), address(gate));
        vm.expectRevert("registry required");
        new VaultFactory(address(usdc), address(0), address(gate));
        vm.expectRevert("refusal gate required");
        new VaultFactory(address(usdc), address(registry), address(0));
    }

    /// @notice A vault's series is not chosen by its creator: it is whatever
    ///         the strategy's pinned spec names, and the registry only allows
    ///         canonical series. A rogue series cannot even be pinned.
    function test_RogueSeriesCannotReachAVault() public {
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(StrategyRegistry.SeriesNotCanonical.selector, address(rogueSeries)));
        registry.pinStrategy{ value: 0.01 ether }(keccak256("x"), COMMIT, address(rogueSeries));
    }

    function testFuzz_CallerIsAlwaysTheOwner(address caller, uint256 drawdown) public {
        vm.assume(caller != address(0));
        drawdown = bound(drawdown, 1, 10_000);
        vm.deal(caller, 1 ether);
        vm.prank(caller);
        uint256 sid = registry.pinStrategy{ value: 0.01 ether }(keccak256(abi.encode(caller)), COMMIT, address(ethSeries));

        vm.prank(caller);
        GuardedVault v = GuardedVault(
            factory.createGuardedVault(executor, sid, _whitelist(), drawdown)
        );
        assertEq(v.owner(), caller);
        assertEq(factory.guardedVaultsOf(caller)[0], address(v));
    }

    // ------------------------------------------------------------------
    // Loosening a vault waits out the cooling-off (factory-level hold)
    // ------------------------------------------------------------------

    bytes32 constant DOGE = keccak256("DOGE-USD");

    function _wl(bytes32 a) internal pure returns (bytes32[] memory w) {
        w = new bytes32[](1);
        w[0] = a;
    }

    function _wl3() internal pure returns (bytes32[] memory w) {
        w = new bytes32[](3);
        w[0] = BTC;
        w[1] = ETH;
        w[2] = DOGE;
    }

    function _mk(bytes32[] memory wl, uint256 dd) internal returns (address v) {
        vm.prank(alice);
        v = factory.createGuardedVault(executor, aliceStrategy, wl, dd);
    }

    function _request(bytes32[] memory wl, uint256 dd) internal returns (uint256 availableAt) {
        vm.prank(alice);
        (, availableAt) = factory.requestLooserVault(aliceStrategy, wl, dd);
    }

    function test_Hold_FirstVaultAndTighterOrEqualVaultsAreImmediate_AndSetThePosture() public {
        _mk(_whitelist(), 1_000); // first vault: nothing to loosen
        (bool set, uint256 dd) = factory.postureOf(alice, aliceStrategy);
        assertTrue(set);
        assertEq(dd, 1_000);
        assertTrue(factory.postureAllowsAsset(alice, aliceStrategy, BTC));
        assertFalse(factory.postureAllowsAsset(alice, aliceStrategy, DOGE));

        _mk(_whitelist(), 1_000); // equal
        bytes32[] memory reordered = new bytes32[](2);
        reordered[0] = ETH;
        reordered[1] = BTC;
        _mk(reordered, 1_000); // same set, other order: still not looser

        _mk(_wl(BTC), 500); // tighter: lower cap AND a subset
        (, dd) = factory.postureOf(alice, aliceStrategy);
        assertEq(dd, 500, "the posture follows the newest vault");
        assertFalse(factory.postureAllowsAsset(alice, aliceStrategy, ETH));
        assertEq(factory.guardedVaultsOf(alice).length, 4);
    }

    function test_Hold_LooserCapNeedsARequestThatHasWaitedOutTheCooldown() public {
        _mk(_whitelist(), 1_000);

        vm.prank(alice);
        vm.expectRevert(VaultFactory.NoLoosenRequest.selector);
        factory.createGuardedVault(executor, aliceStrategy, _whitelist(), 2_000);

        uint256 availableAt = _request(_whitelist(), 2_000);
        assertEq(availableAt, block.timestamp + 1 days);

        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(VaultFactory.LoosenHold.selector, availableAt));
        factory.createGuardedVault(executor, aliceStrategy, _whitelist(), 2_000);

        vm.warp(availableAt - 1);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(VaultFactory.LoosenHold.selector, availableAt));
        factory.createGuardedVault(executor, aliceStrategy, _whitelist(), 2_000);

        vm.warp(availableAt);
        address v = _mk(_whitelist(), 2_000);
        assertTrue(factory.isVault(v));
        (, uint256 dd) = factory.postureOf(alice, aliceStrategy);
        assertEq(dd, 2_000);
    }

    function test_Hold_LooserWhitelistNeedsTheHoldToo() public {
        _mk(_whitelist(), 1_000);
        assertTrue(factory.isLooserThanPosture(alice, aliceStrategy, _wl3(), 1_000));

        vm.prank(alice);
        vm.expectRevert(VaultFactory.NoLoosenRequest.selector);
        factory.createGuardedVault(executor, aliceStrategy, _wl3(), 1_000); // adds DOGE

        uint256 availableAt = _request(_wl3(), 1_000);
        vm.warp(availableAt);
        _mk(_wl3(), 1_000);
        assertTrue(factory.postureAllowsAsset(alice, aliceStrategy, DOGE));
    }

    /// @notice The bypass this closes: create a tight vault, then immediately a
    ///         looser one. The posture is the NEWEST vault, so the second is a
    ///         loosening and must wait.
    function test_Hold_TightThenLooseStraightAfter_DoesNotBypass() public {
        _mk(_whitelist(), 1_000);
        _mk(_wl(BTC), 300); // tighten

        vm.prank(alice);
        vm.expectRevert(VaultFactory.NoLoosenRequest.selector);
        factory.createGuardedVault(executor, aliceStrategy, _whitelist(), 1_000); // back to the old limits

        uint256 availableAt = _request(_whitelist(), 1_000);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(VaultFactory.LoosenHold.selector, availableAt));
        factory.createGuardedVault(executor, aliceStrategy, _whitelist(), 1_000);

        vm.warp(availableAt);
        _mk(_whitelist(), 1_000);
    }

    function test_Hold_RequestIsConsumedAndDoesNotAuthorizeAnythingElse() public {
        _mk(_whitelist(), 1_000);
        uint256 availableAt = _request(_whitelist(), 2_000);
        vm.warp(availableAt);

        // A request for cap 2_000 does not authorize 3_000, or a different whitelist.
        vm.prank(alice);
        vm.expectRevert(VaultFactory.NoLoosenRequest.selector);
        factory.createGuardedVault(executor, aliceStrategy, _whitelist(), 3_000);
        vm.prank(alice);
        vm.expectRevert(VaultFactory.NoLoosenRequest.selector);
        factory.createGuardedVault(executor, aliceStrategy, _wl3(), 2_000);

        _mk(_whitelist(), 2_000); // consumes it
        assertEq(
            factory.loosenRequestedAt(factory.looserVaultRequestId(alice, aliceStrategy, _whitelist(), 2_000)), 0
        );

        // Tighten again, then ask for the same loosening: a NEW request is needed.
        _mk(_whitelist(), 1_000);
        vm.prank(alice);
        vm.expectRevert(VaultFactory.NoLoosenRequest.selector);
        factory.createGuardedVault(executor, aliceStrategy, _whitelist(), 2_000);
    }

    function test_Hold_RequestingAgainDoesNotRestartTheClock() public {
        _mk(_whitelist(), 1_000);
        uint256 first = _request(_whitelist(), 2_000);
        vm.warp(block.timestamp + 6 hours);
        uint256 second = _request(_whitelist(), 2_000);
        assertEq(second, first);
    }

    function test_Hold_OnlyTheStrategyOwnerCanRequest_AndOthersCannotUseYourRequest() public {
        _mk(_whitelist(), 1_000);
        vm.prank(bob);
        vm.expectRevert(VaultFactory.NotStrategyOwner.selector);
        factory.requestLooserVault(aliceStrategy, _whitelist(), 2_000);

        // Bob pins his own strategy; alice's request id (keyed by her address) is useless to him.
        vm.prank(bob);
        uint256 bobStrategy = registry.pinStrategy{ value: 0.01 ether }(keccak256("b"), COMMIT, address(btcSeries));
        vm.prank(bob);
        factory.createGuardedVault(executor, bobStrategy, _whitelist(), 1_000);
        uint256 availableAt = _request(_whitelist(), 2_000);
        vm.warp(availableAt);
        vm.prank(bob);
        vm.expectRevert(VaultFactory.NoLoosenRequest.selector);
        factory.createGuardedVault(executor, bobStrategy, _whitelist(), 2_000);
    }

    function test_Hold_PostureIsPerStrategy() public {
        _mk(_whitelist(), 1_000);
        vm.prank(alice);
        uint256 second = registry.pinStrategy{ value: 0.01 ether }(keccak256("alice-2"), COMMIT, address(ethSeries));
        // A brand-new strategy has no posture: its first vault is immediate, however loose.
        vm.prank(alice);
        factory.createGuardedVault(executor, second, _wl3(), 5_000);
        (, uint256 dd) = factory.postureOf(alice, aliceStrategy);
        assertEq(dd, 1_000, "the first strategy's posture is untouched");
    }

    function test_Hold_CooldownIsTheRegistrys() public {
        _mk(_whitelist(), 1_000);
        uint256 availableAt = _request(_whitelist(), 2_000);
        assertEq(availableAt - block.timestamp, registry.loosenCooldownSeconds());
    }

    /// @notice Model check: random requests, creations and time steps. A
    ///         creation succeeds EXACTLY when it is tighter-or-equal to the
    ///         newest vault's limits, or a matching request has aged a full
    ///         cooldown.
    mapping(bytes32 => uint256) internal _ghostRequest;

    function testFuzz_HoldMatchesTheModel(uint256 seed) public {
        bytes32[4] memory assets = [BTC, ETH, DOGE, keccak256("SOL-USD")];
        uint256 cooldown = registry.loosenCooldownSeconds();
        bool postureSet;
        uint256 postureDd;
        uint256 postureMask;

        for (uint256 i = 0; i < 24; i++) {
            uint256 r = uint256(keccak256(abi.encode(seed, i)));
            uint256 op = r % 4;
            uint256 dd = 100 + ((r >> 8) % 4) * 400; // 100, 500, 900, 1300
            uint256 mask = 1 + ((r >> 16) % 15); // non-empty subset of 4 assets
            bytes32[] memory wl = new bytes32[](_popcount(mask));
            uint256 k;
            for (uint256 a = 0; a < 4; a++) {
                if (mask & (1 << a) != 0) wl[k++] = assets[a];
            }
            bytes32 key = keccak256(abi.encode(dd, mask));

            if (op == 0) {
                vm.warp(block.timestamp + ((r >> 24) % (cooldown + cooldown / 2)));
            } else if (op == 1) {
                _request(wl, dd);
                if (_ghostRequest[key] == 0) _ghostRequest[key] = block.timestamp;
            } else {
                bool looser = postureSet && (dd > postureDd || (mask & ~postureMask) != 0);
                bool expectOk = !looser || (_ghostRequest[key] != 0 && block.timestamp >= _ghostRequest[key] + cooldown);

                vm.prank(alice);
                try factory.createGuardedVault(executor, aliceStrategy, wl, dd) {
                    assertTrue(expectOk, "a looser vault was created without a matured request");
                    if (looser) delete _ghostRequest[key];
                    postureSet = true;
                    postureDd = dd;
                    postureMask = mask;
                } catch {
                    assertFalse(expectOk, "a permitted vault was refused");
                }
            }
        }
    }

    function _popcount(uint256 x) internal pure returns (uint256 c) {
        while (x != 0) {
            c += x & 1;
            x >>= 1;
        }
    }
}
