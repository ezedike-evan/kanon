// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import { Test } from "forge-std/Test.sol";
import { CanonicalSeries } from "../src/CanonicalSeries.sol";
import { MarginAccount } from "../src/MarginAccount.sol";
import { InsuranceFund } from "../src/InsuranceFund.sol";
import { GuardedVault } from "../src/GuardedVault.sol";
import { CopyVault } from "../src/CopyVault.sol";
import { RefusalGate } from "../src/RefusalGate.sol";
import { StrategyRegistry } from "../src/StrategyRegistry.sol";
import { SafeERC20 } from "../src/SafeERC20.sol";
import { ReentrancyGuard } from "../src/ReentrancyGuard.sol";
import { MockPyth } from "./mocks/MockPyth.sol";
import { NoReturnERC20 } from "./mocks/NoReturnERC20.sol";
import { FalseReturnERC20 } from "./mocks/FalseReturnERC20.sol";
import { FeeOnTransferERC20 } from "./mocks/FeeOnTransferERC20.sol";
import { ReentrantERC20 } from "./mocks/ReentrantERC20.sol";
import { ReentrancyAttacker } from "./mocks/ReentrancyAttacker.sol";
import { one } from "./helpers/GateFixture.sol";

/// @dev Exercises SafeERC20 + the balance-delta check + nonReentrant on every
///      token-moving contract, with hostile token behaviours.
contract TokenSafetyTest is Test {
    bytes32 constant FEED = bytes32(uint256(1));
    CanonicalSeries series;
    StrategyRegistry registry;
    RefusalGate gate;
    uint256 strategyId;
    address user = address(0xA11CE);

    function setUp() public {
        series = new CanonicalSeries("BTC/USD", FEED, 300, 900, address(new MockPyth()), 60);
        registry = new StrategyRegistry(0.01 ether, 1 days, one(address(series)));
        gate = new RefusalGate(address(registry));
        vm.deal(address(this), 1 ether);
        strategyId = registry.pinStrategy{ value: 0.01 ether }(keccak256("s"), keccak256("c"), address(series));
    }

    // ---------------- builders ----------------

    function _margin(address token) internal returns (MarginAccount m, InsuranceFund f) {
        address predicted = vm.computeCreateAddress(address(this), vm.getNonce(address(this)) + 1);
        f = new InsuranceFund(token, predicted);
        m = new MarginAccount(token, 1000, address(f), 200, 1.2e18, 2_500, address(gate));
        assertEq(address(m), predicted);
    }

    function _guarded(address token, address owner_) internal returns (GuardedVault v) {
        bytes32[] memory wl = new bytes32[](1);
        wl[0] = keccak256("BTC");
        v = new GuardedVault(token, owner_, address(0xE), address(registry), strategyId, wl, 1_000, address(gate));
    }

    function _copy(address token, address follower_) internal returns (CopyVault v) {
        v = new CopyVault(token, follower_, address(0xE), address(registry), strategyId, 5_000, 1_000, address(0xF), address(gate));
    }

    // ---------------- no-return-value token ----------------

    function test_NoReturnToken_AllContractsWork() public {
        NoReturnERC20 t = new NoReturnERC20();
        (MarginAccount m, InsuranceFund f) = _margin(address(t));
        GuardedVault g = _guarded(address(t), user);
        CopyVault c = _copy(address(t), user);
        t.mint(user, 3_000);

        vm.startPrank(user);
        t.approve(address(m), type(uint256).max);
        t.approve(address(f), type(uint256).max);
        t.approve(address(g), type(uint256).max);
        t.approve(address(c), type(uint256).max);

        m.deposit(500);
        m.withdraw(200);
        assertEq(m.collateralOf(user), 300);
        f.deposit(300);
        g.deposit(400);
        g.withdraw(100);
        c.deposit(400);
        c.withdraw(100);
        vm.stopPrank();

        assertEq(t.balanceOf(address(m)), 300);
        assertEq(t.balanceOf(address(f)), 300);
        assertEq(t.balanceOf(address(g)), 300);
        assertEq(t.balanceOf(address(c)), 300);
        assertEq(t.balanceOf(user), 3_000 - 300 - 300 - 300 - 300);
    }

    // ---------------- false-returning token ----------------

    function test_FalseReturnToken_RevertsEverywhere() public {
        FalseReturnERC20 t = new FalseReturnERC20();
        (MarginAccount m, InsuranceFund f) = _margin(address(t));
        GuardedVault g = _guarded(address(t), user);
        CopyVault c = _copy(address(t), user);

        vm.startPrank(user);
        vm.expectRevert(SafeERC20.SafeERC20Failed.selector);
        m.deposit(1);
        vm.expectRevert(SafeERC20.SafeERC20Failed.selector);
        f.deposit(1);
        vm.expectRevert(SafeERC20.SafeERC20Failed.selector);
        g.deposit(1);
        vm.expectRevert(SafeERC20.SafeERC20Failed.selector);
        c.deposit(1);
        vm.stopPrank();
    }

    function test_SafeERC20_NonContractTokenReverts() public {
        // A token address with no code must not be treated as a successful transfer.
        (MarginAccount m,) = _margin(address(0xdead));
        vm.prank(user);
        vm.expectRevert(); // no code at the token address: never a silent success
        m.deposit(1);
    }

    // ---------------- fee-on-transfer token ----------------

    function testFuzz_FeeOnTransfer_DepositsRevertAndCreditNothing(uint256 feeBps, uint256 amount) public {
        feeBps = bound(feeBps, 1, 9_999);
        amount = bound(amount, 10_000, 1e30); // fee >= 1 wei
        FeeOnTransferERC20 t = new FeeOnTransferERC20(feeBps);
        (MarginAccount m, InsuranceFund f) = _margin(address(t));
        GuardedVault g = _guarded(address(t), user);
        CopyVault c = _copy(address(t), user);
        t.mint(user, amount * 4);

        vm.startPrank(user);
        t.approve(address(m), amount);
        t.approve(address(f), amount);
        t.approve(address(g), amount);
        t.approve(address(c), amount);
        vm.expectPartialRevert(SafeERC20.ReceivedLessThanAmount.selector);
        m.deposit(amount);
        vm.expectPartialRevert(SafeERC20.ReceivedLessThanAmount.selector);
        f.deposit(amount);
        vm.expectPartialRevert(SafeERC20.ReceivedLessThanAmount.selector);
        g.deposit(amount);
        vm.expectPartialRevert(SafeERC20.ReceivedLessThanAmount.selector);
        c.deposit(amount);
        vm.stopPrank();

        assertEq(m.collateralOf(user), 0);
        assertEq(m.totalCollateral(), 0);
        assertEq(g.totalCollateral(), 0);
        assertEq(c.collateral(), 0);
    }

    function test_FeeOnTransfer_ZeroFeeTokenStillWorks() public {
        FeeOnTransferERC20 t = new FeeOnTransferERC20(0);
        (MarginAccount m,) = _margin(address(t));
        t.mint(user, 100);
        vm.startPrank(user);
        t.approve(address(m), 100);
        m.deposit(100);
        vm.stopPrank();
        assertEq(m.collateralOf(user), 100);
    }

    // ---------------- reentrant hook token ----------------

    function test_Reentrancy_MarginDeposit() public {
        ReentrantERC20 t = new ReentrantERC20();
        (MarginAccount m,) = _margin(address(t));
        ReentrancyAttacker a = new ReentrancyAttacker();
        t.mint(address(a), 10);
        a.approveToken(address(t), address(m));
        t.arm(address(a), abi.encodeCall(ReentrancyAttacker.go, (address(m), abi.encodeCall(MarginAccount.deposit, (1)))));

        vm.expectRevert(ReentrancyGuard.Reentrancy.selector);
        a.go(address(m), abi.encodeCall(MarginAccount.deposit, (5)));
        assertEq(m.collateralOf(address(a)), 0);
    }

    function test_Reentrancy_MarginWithdraw() public {
        ReentrantERC20 t = new ReentrantERC20();
        (MarginAccount m,) = _margin(address(t));
        ReentrancyAttacker a = new ReentrancyAttacker();
        t.mint(address(a), 10);
        a.approveToken(address(t), address(m));
        a.go(address(m), abi.encodeCall(MarginAccount.deposit, (10)));

        t.arm(address(a), abi.encodeCall(ReentrancyAttacker.go, (address(m), abi.encodeCall(MarginAccount.withdraw, (5)))));
        vm.expectRevert(ReentrancyGuard.Reentrancy.selector);
        a.go(address(m), abi.encodeCall(MarginAccount.withdraw, (5)));
        assertEq(m.collateralOf(address(a)), 10);
    }

    function test_Reentrancy_InsuranceFundDeposit() public {
        ReentrantERC20 t = new ReentrantERC20();
        (, InsuranceFund f) = _margin(address(t));
        ReentrancyAttacker a = new ReentrancyAttacker();
        t.mint(address(a), 10);
        a.approveToken(address(t), address(f));
        t.arm(address(a), abi.encodeCall(ReentrancyAttacker.go, (address(f), abi.encodeCall(InsuranceFund.deposit, (1)))));
        vm.expectRevert(ReentrancyGuard.Reentrancy.selector);
        a.go(address(f), abi.encodeCall(InsuranceFund.deposit, (5)));
    }

    function test_Reentrancy_GuardedVaultWithdraw() public {
        ReentrantERC20 t = new ReentrantERC20();
        ReentrancyAttacker a = new ReentrancyAttacker();
        GuardedVault g = _guarded(address(t), address(a));
        t.mint(address(a), 10);
        a.approveToken(address(t), address(g));
        a.go(address(g), abi.encodeCall(GuardedVault.deposit, (10)));

        t.arm(address(a), abi.encodeCall(ReentrancyAttacker.go, (address(g), abi.encodeCall(GuardedVault.withdraw, (5)))));
        vm.expectRevert(ReentrancyGuard.Reentrancy.selector);
        a.go(address(g), abi.encodeCall(GuardedVault.withdraw, (5)));
        assertEq(g.totalCollateral(), 10);
    }

    function test_Reentrancy_CopyVaultWithdraw() public {
        ReentrantERC20 t = new ReentrantERC20();
        ReentrancyAttacker a = new ReentrancyAttacker();
        CopyVault c = _copy(address(t), address(a));
        t.mint(address(a), 10);
        a.approveToken(address(t), address(c));
        a.go(address(c), abi.encodeCall(CopyVault.deposit, (10)));

        t.arm(address(a), abi.encodeCall(ReentrancyAttacker.go, (address(c), abi.encodeCall(CopyVault.withdraw, (5)))));
        vm.expectRevert(ReentrancyGuard.Reentrancy.selector);
        a.go(address(c), abi.encodeCall(CopyVault.withdraw, (5)));
        assertEq(c.collateral(), 10);
    }
}
