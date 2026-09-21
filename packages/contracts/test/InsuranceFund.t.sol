// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import { Test } from "forge-std/Test.sol";
import { InsuranceFund } from "../src/InsuranceFund.sol";
import { MockERC20 } from "./mocks/MockERC20.sol";

contract InsuranceFundTest is Test {
    MockERC20 usdc;
    InsuranceFund fund;

    address margin = address(0xAA11);
    address alice = address(0xA11CE);
    address deployer;

    event Deposited(address indexed from, uint256 amount);
    event PenaltyReceived(uint256 amount);
    event ShortfallCovered(uint256 requested, uint256 covered);

    function setUp() public {
        deployer = address(this);
        usdc = new MockERC20("USD Coin", "USDC", 18);
        fund = new InsuranceFund(address(usdc), margin);

        usdc.mint(alice, 10_000);
        vm.prank(alice);
        usdc.approve(address(fund), type(uint256).max);
    }

    function test_Deposit_AnyoneCanTopUp() public {
        vm.expectEmit(true, false, false, true);
        emit Deposited(alice, 1_000);
        vm.prank(alice);
        fund.deposit(1_000);

        assertEq(fund.balance(), 1_000);
        assertEq(fund.totalDeposited(), 1_000);
    }

    function test_Deposit_ZeroReverts() public {
        vm.prank(alice);
        vm.expectRevert(InsuranceFund.ZeroAmount.selector);
        fund.deposit(0);
    }

    function test_RecordPenalty_OnlyMargin() public {
        vm.prank(alice);
        vm.expectRevert(InsuranceFund.NotMargin.selector);
        fund.recordPenalty(1);

        vm.expectEmit(false, false, false, true);
        emit PenaltyReceived(50);
        vm.prank(margin);
        fund.recordPenalty(50);
        assertEq(fund.totalPenaltiesReceived(), 50);
    }

    function test_CoverShortfall_OnlyMargin_EvenTheDeployerIsRejected() public {
        vm.prank(alice);
        fund.deposit(1_000);

        vm.expectRevert(InsuranceFund.NotMargin.selector);
        fund.coverShortfall(1); // deployer / test contract

        vm.prank(alice);
        vm.expectRevert(InsuranceFund.NotMargin.selector);
        fund.coverShortfall(1);

        assertEq(fund.balance(), 1_000);
    }

    function test_CoverShortfall_PaysOnlyToMargin_UpToBalance() public {
        vm.prank(alice);
        fund.deposit(1_000);

        vm.expectEmit(false, false, false, true);
        emit ShortfallCovered(400, 400);
        vm.prank(margin);
        assertEq(fund.coverShortfall(400), 400);
        assertEq(usdc.balanceOf(margin), 400);
        assertEq(fund.balance(), 600);

        // Asking for more than is left pays what is left, never more.
        vm.prank(margin);
        assertEq(fund.coverShortfall(10_000), 600);
        assertEq(fund.balance(), 0);
        assertEq(fund.totalShortfallCovered(), 1_000);

        // Empty fund: pays zero and does not revert.
        vm.prank(margin);
        assertEq(fund.coverShortfall(5), 0);
    }

    function test_Constructor_RequiresTokenAndMargin() public {
        vm.expectRevert("collateral token required");
        new InsuranceFund(address(0), margin);
        vm.expectRevert("margin required");
        new InsuranceFund(address(usdc), address(0));
    }

    /// @notice There is no withdrawal path: whatever calldata anyone other
    ///         than the bound margin sends, the fund's balance never falls.
    function testFuzz_NoOneButMarginCanReduceTheFund(address caller, bytes calldata data) public {
        vm.assume(caller != margin && caller != address(usdc));
        vm.prank(alice);
        fund.deposit(1_000);

        uint256 before = usdc.balanceOf(address(fund));
        vm.prank(caller);
        (bool ok,) = address(fund).call(data);
        ok; // most random calldata reverts; either outcome is fine
        assertGe(usdc.balanceOf(address(fund)), before);
    }
}
