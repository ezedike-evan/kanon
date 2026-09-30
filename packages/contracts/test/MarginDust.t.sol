// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import { Test } from "forge-std/Test.sol";
import { CanonicalSeries } from "../src/CanonicalSeries.sol";
import { MarginAccount } from "../src/MarginAccount.sol";
import { InsuranceFund } from "../src/InsuranceFund.sol";
import { RefusalGate } from "../src/RefusalGate.sol";
import { MockPyth } from "./mocks/MockPyth.sol";
import { MockERC20 } from "./mocks/MockERC20.sol";
import { deployGate, one } from "./helpers/GateFixture.sol";

/// @dev Dust positions (size * adlFractionBps < BPS) used to revert `NothingToDeleverage`.
///      The slice is now rounded UP, so a dust position is always reducible.
contract MarginDustTest is Test {
    bytes32 constant FEED = bytes32(uint256(1));
    MockPyth pyth;
    CanonicalSeries series;
    MockERC20 usdc;
    RefusalGate gate;
    address alice = address(0xA11CE);

    function setUp() public {
        pyth = new MockPyth();
        series = new CanonicalSeries("BTC/USD", FEED, 300, 900, address(pyth), 60);
        usdc = new MockERC20("USD Coin", "USDC", 18);
        (, gate) = deployGate(one(address(series)));
        vm.warp(1_000_000 * 900);
        pyth.setPrice(FEED, 100_000, 1, -8, block.timestamp);
        series.recordSample();
    }

    function _margin(uint256 maintenanceBps, uint256 adlFractionBps) internal returns (MarginAccount m) {
        address predicted = vm.computeCreateAddress(address(this), vm.getNonce(address(this)) + 1);
        InsuranceFund f = new InsuranceFund(address(usdc), predicted);
        m = new MarginAccount(address(usdc), maintenanceBps, address(f), 200, 1.2e18, adlFractionBps, address(gate));
    }

    function _fund(MarginAccount m, uint256 amount) internal {
        usdc.mint(alice, amount);
        vm.startPrank(alice);
        usdc.approve(address(m), type(uint256).max);
        m.deposit(amount);
        vm.stopPrank();
    }

    function test_DustPosition_IsReducedBySmallestSlice_NotStuck() public {
        // 5% ADL fraction, 10% maintenance: size 19 -> floor(0.95) == 0 (used to revert).
        MarginAccount m = _margin(1_000, 500);
        _fund(m, 1);
        vm.prank(alice);
        uint256 id = m.openPosition(address(series), true, 19);
        assertEq(m.healthFactor(alice), 1e18); // equity 1 / maintenance 1

        (uint256 pid, uint256 closed) = m.deleverage(alice);
        assertEq(pid, id);
        assertEq(closed, 1, "rounded up to one unit");
        (,, uint256 size,, bool open) = m.positionOf(alice, id);
        assertEq(size, 18);
        assertTrue(open);
    }

    function test_DustPosition_ClosedWholeWhenSliceCoversIt() public {
        // 100% maintenance: size 1 needs 1 unit of margin; slice rounds up to the whole position.
        MarginAccount m = _margin(10_000, 2_500);
        _fund(m, 1);
        vm.prank(alice);
        uint256 id = m.openPosition(address(series), true, 1);

        (, uint256 closed) = m.deleverage(alice);
        assertEq(closed, 1);
        (,, uint256 size,, bool open) = m.positionOf(alice, id);
        assertEq(size, 0);
        assertFalse(open);
        assertEq(m.openPositionCount(alice), 0);
    }

    function testFuzz_RoundedUpSliceNeverExceedsPositionAndIsNonZero(uint256 size, uint256 fraction) public {
        fraction = bound(fraction, 1, 9_999);
        size = bound(size, 10, 1e12);
        MarginAccount m = _margin(1_000, fraction);
        // Collateral exactly at maintenance: health 1.0, deleverageable.
        uint256 maintenance = (size * 1_000) / 10_000;
        _fund(m, maintenance);
        vm.prank(alice);
        uint256 id = m.openPosition(address(series), true, size);

        (, uint256 closed) = m.deleverage(alice);
        assertGt(closed, 0);
        assertLe(closed, size);
        assertEq(closed, (size * fraction + 9_999) / 10_000);
        (,, uint256 remaining,,) = m.positionOf(alice, id);
        assertEq(remaining, size - closed);
    }
}
