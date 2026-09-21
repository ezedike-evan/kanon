// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import { Test } from "forge-std/Test.sol";
import { StdInvariant } from "forge-std/StdInvariant.sol";
import { CanonicalSeries } from "../src/CanonicalSeries.sol";
import { MarginAccount } from "../src/MarginAccount.sol";
import { InsuranceFund } from "../src/InsuranceFund.sol";
import { MockPyth } from "./mocks/MockPyth.sol";
import { MockERC20 } from "./mocks/MockERC20.sol";
import { RefusalGate } from "../src/RefusalGate.sol";
import { deployGate, one, two } from "./helpers/GateFixture.sol";

/**
 * @notice Drives MarginAccount + InsuranceFund with random sequences of every
 *         external action (deposit, withdraw, open, close, liquidate, ADL,
 *         price moves, fund top-ups) from a handful of actors, and asserts
 *         the properties the risk engine must never lose:
 *
 *         - collateral conservation (the ledger identity; Σ accounts ==
 *           totalCollateral; no token created, destroyed or leaked),
 *         - nobody but an account's owner moves that account's tokens; a
 *           third party's `liquidate`/`deleverage` only ever succeeds inside
 *           its documented health band and pays the caller nothing,
 *         - collateral and debt are mutually exclusive,
 *         - ADL never lowers health,
 *         - the fund only ever grows from deposits/penalties and shrinks only
 *           through shortfall cover paid to the margin.
 */
contract MarginHandler is Test {
    bytes32 constant FEED_A = bytes32(uint256(1));
    bytes32 constant FEED_B = bytes32(uint256(2));
    uint256 constant BUCKET = 900;

    MockPyth public pyth;
    CanonicalSeries public seriesA;
    CanonicalSeries public seriesB;
    MockERC20 public usdc;
    MarginAccount public margin;
    InsuranceFund public fund;

    address[] public actors;
    address public keeper = address(0xBEEF); // only ever calls liquidate/deleverage
    address public donor = address(0xD0D0); // only ever tops up the fund
    uint256 public constant MINT = 1_000_000;

    // ghosts
    mapping(address => int256) public netDeposited; // own deposits - own withdrawals
    uint256 public ghostBadLiquidations; // liquidate succeeded outside its band
    uint256 public ghostBadDeleverages; // deleverage succeeded outside its band
    uint256 public ghostHealthDropOnAdl; // ADL lowered the health factor
    uint256 public ghostFundDeposited;
    uint256 public lastUncoveredBadDebt;
    uint256 public ghostUncoveredRegressions;
    uint256 public liquidations;
    uint256 public deleverages;
    uint256 public debtEvents;

    constructor() {
        pyth = new MockPyth();
        seriesA = new CanonicalSeries("A", FEED_A, 1, BUCKET, address(pyth), 60);
        seriesB = new CanonicalSeries("B", FEED_B, 1, BUCKET, address(pyth), 60);
        usdc = new MockERC20("USD Coin", "USDC", 18);

        (, RefusalGate gate) = deployGate(two(address(seriesA), address(seriesB)));
        address predicted = vm.computeCreateAddress(address(this), vm.getNonce(address(this)) + 1);
        fund = new InsuranceFund(address(usdc), predicted);
        margin = new MarginAccount(address(usdc), 1000, address(fund), 200, 1.2e18, 2_500, address(gate));

        vm.warp(1_000_000 * BUCKET);
        _record(100_000, 100_000);

        actors.push(address(0xA11CE));
        actors.push(address(0xB0B));
        actors.push(address(0xCA401));
        for (uint256 i = 0; i < actors.length; i++) {
            usdc.mint(actors[i], MINT);
            vm.prank(actors[i]);
            usdc.approve(address(margin), type(uint256).max);
        }
        usdc.mint(donor, MINT);
        vm.prank(donor);
        usdc.approve(address(fund), type(uint256).max);
    }

    function actorCount() external view returns (uint256) {
        return actors.length;
    }

    function _actor(uint256 seed) internal view returns (address) {
        return actors[seed % actors.length];
    }

    function _record(int64 a, int64 b) internal {
        pyth.setPrice(FEED_A, a, 1, -8, block.timestamp);
        seriesA.recordSample();
        pyth.setPrice(FEED_B, b, 1, -8, block.timestamp);
        seriesB.recordSample();
    }

    // ------------------------------------------------------------------
    // actions
    // ------------------------------------------------------------------

    int64 public lastA = 100_000;
    int64 public lastB = 100_000;

    /// @dev Each series moves by at most +/-20% per step (clamped to
    ///      [30_000, 300_000]) so accounts drift through the ADL band and into
    ///      liquidation instead of teleporting past them.
    function movePrice(uint256 a, uint256 b) external {
        vm.warp(block.timestamp + BUCKET);
        lastA = _step(lastA, a);
        lastB = _step(lastB, b);
        _record(lastA, lastB);
    }

    function _step(int64 last, uint256 seed) internal pure returns (int64) {
        uint256 pct = bound(seed, 80, 120);
        uint256 next = (uint256(uint64(last)) * pct) / 100;
        if (next < 30_000) next = 30_000;
        if (next > 300_000) next = 300_000;
        return int64(uint64(next));
    }

    function deposit(uint256 seed, uint256 amount) external {
        address who = _actor(seed);
        amount = bound(amount, 300, 30_000);
        if (usdc.balanceOf(who) < amount) return;
        vm.prank(who);
        margin.deposit(amount);
        netDeposited[who] += int256(amount);
    }

    function withdraw(uint256 seed, uint256 amount) external {
        address who = _actor(seed);
        amount = bound(amount, 1, 30_000);
        vm.prank(who);
        try margin.withdraw(amount) {
            netDeposited[who] -= int256(amount);
        } catch { }
    }

    function open(uint256 seed, bool isLong, bool useB, uint256 size) external {
        address who = _actor(seed);
        uint256 c = margin.collateralOf(who);
        if (c < 300) return;
        // 2x .. 9.5x leverage against a 10x limit: near enough to the edge that
        // ordinary price moves reach the ADL band and liquidation.
        size = bound(size, c * 2, (c * 19) / 2);
        vm.prank(who);
        try margin.openPosition(address(useB ? seriesB : seriesA), isLong, size) { } catch { }
    }

    function close(uint256 seed, uint256 posSeed) external {
        address who = _actor(seed);
        uint256 n = margin.positionCount(who);
        if (n == 0) return;
        vm.prank(who);
        try margin.closePosition(posSeed % n) { } catch { }
    }

    function liquidate(uint256 callerSeed, uint256 targetSeed, uint256 posSeed) external {
        address caller = callerSeed % 4 == 0 ? keeper : _actor(callerSeed);
        address target = _actor(targetSeed);
        uint256 n = margin.positionCount(target);
        if (n == 0) return;

        uint256 healthBefore;
        try margin.healthFactor(target) returns (uint256 h) {
            healthBefore = h;
        } catch {
            return;
        }
        uint256 callerTokens = usdc.balanceOf(caller);

        vm.prank(caller);
        try margin.liquidate(target, posSeed % n) {
            liquidations++;
            if (healthBefore >= 1e18) ghostBadLiquidations++;
            if (usdc.balanceOf(caller) != callerTokens) ghostBadLiquidations++; // caller was paid
        } catch { }
        _trackBadDebt();
    }

    function deleverage(uint256 callerSeed, uint256 targetSeed) external {
        address caller = callerSeed % 4 == 0 ? keeper : _actor(callerSeed);
        address target = _actor(targetSeed);

        uint256 healthBefore;
        try margin.healthFactor(target) returns (uint256 h) {
            healthBefore = h;
        } catch {
            return;
        }
        uint256 callerTokens = usdc.balanceOf(caller);

        vm.prank(caller);
        try margin.deleverage(target) {
            deleverages++;
            if (healthBefore < 1e18 || healthBefore >= margin.adlHealthThreshold()) ghostBadDeleverages++;
            if (margin.healthFactor(target) < healthBefore) ghostHealthDropOnAdl++;
            if (usdc.balanceOf(caller) != callerTokens) ghostBadDeleverages++;
        } catch { }
    }

    function fundTopUp(uint256 amount) external {
        amount = bound(amount, 1, 5_000);
        vm.prank(donor);
        fund.deposit(amount);
        ghostFundDeposited += amount;
    }

    function _trackBadDebt() internal {
        uint256 u = margin.uncoveredBadDebt();
        if (u < lastUncoveredBadDebt) ghostUncoveredRegressions++;
        lastUncoveredBadDebt = u;
    }
}

contract MarginInvariantsTest is StdInvariant, Test {
    MarginHandler handler;
    MockERC20 usdc;
    MarginAccount margin;
    InsuranceFund fund;

    function setUp() public {
        handler = new MarginHandler();
        usdc = handler.usdc();
        margin = handler.margin();
        fund = handler.fund();

        bytes4[] memory selectors = new bytes4[](8);
        selectors[0] = MarginHandler.movePrice.selector;
        selectors[1] = MarginHandler.deposit.selector;
        selectors[2] = MarginHandler.withdraw.selector;
        selectors[3] = MarginHandler.open.selector;
        selectors[4] = MarginHandler.close.selector;
        selectors[5] = MarginHandler.liquidate.selector;
        selectors[6] = MarginHandler.deleverage.selector;
        selectors[7] = MarginHandler.fundTopUp.selector;
        targetSelector(FuzzSelector({ addr: address(handler), selectors: selectors }));
        targetContract(address(handler));
    }

    // Foundry runs one full campaign per `invariant_*` function, so the
    // properties are grouped into three functions rather than eleven.

    /// @dev COLLATERAL CONSERVATION. Ledger identity
    ///      `token.balanceOf(margin) == totalCollateral + counterpartyBalance`;
    ///      accounts sum to `totalCollateral`; no token is created, destroyed
    ///      or leaked to an unknown address; the fund's balance is exactly
    ///      deposits + penalties - shortfall cover paid to the margin.
    function invariant_CollateralConservation() public view {
        assertEq(
            int256(usdc.balanceOf(address(margin))), int256(margin.totalCollateral()) + margin.counterpartyBalance()
        );

        uint256 sum;
        uint256 supply = usdc.balanceOf(address(margin)) + usdc.balanceOf(address(fund))
            + usdc.balanceOf(handler.keeper()) + usdc.balanceOf(handler.donor());
        for (uint256 i = 0; i < handler.actorCount(); i++) {
            address a = handler.actors(i);
            sum += margin.collateralOf(a);
            supply += usdc.balanceOf(a);
        }
        assertEq(sum, margin.totalCollateral(), "accounts must sum to totalCollateral");
        assertEq(supply, handler.MINT() * (handler.actorCount() + 1), "token supply must be conserved");

        assertEq(
            usdc.balanceOf(address(fund)),
            fund.totalDeposited() + fund.totalPenaltiesReceived() - fund.totalShortfallCovered()
        );
        assertEq(fund.totalDeposited(), handler.ghostFundDeposited());
    }

    /// @dev NO NON-OWNER PATH TO MOVE FUNDS. An actor's wallet only ever
    ///      changes through their OWN deposit and withdraw; liquidation and
    ///      ADL by anyone else only move margin-internal ledger entries, and
    ///      the keeper (who only ever liquidates/deleverages) is never paid.
    ///      Also: collateral and debt are mutually exclusive, and a flat
    ///      account carries no debt.
    function invariant_OnlyTheOwnerMovesTheirFunds() public view {
        for (uint256 i = 0; i < handler.actorCount(); i++) {
            address a = handler.actors(i);
            assertEq(int256(usdc.balanceOf(a)), int256(handler.MINT()) - handler.netDeposited(a));
            assertTrue(margin.collateralOf(a) == 0 || margin.debtOf(a) == 0, "collateral and debt both non-zero");
            if (margin.openPositionCount(a) == 0) assertEq(margin.debtOf(a), 0);
        }
        assertEq(usdc.balanceOf(handler.keeper()), 0, "a keeper/liquidator is never paid");
    }

    /// @dev (Verified separately that random campaigns do reach ADL, liquidation
    ///      and fund-covered shortfalls: temporary "must stay zero" invariants on
    ///      `liquidations`, `deleverages` and `totalShortfallCovered` all failed
    ///      within 60 runs.)
    ///      liquidate/deleverage succeed only inside their documented health
    ///      bands, ADL never lowers health, the bad-debt counter never falls.
    function invariant_RiskEngineStaysInsideItsBands() public view {
        assertEq(handler.ghostBadLiquidations(), 0);
        assertEq(handler.ghostBadDeleverages(), 0);
        assertEq(handler.ghostHealthDropOnAdl(), 0);
        assertEq(handler.ghostUncoveredRegressions(), 0);
    }
}

/**
 * @notice Stateless fuzz of the arithmetic and of the "a stranger cannot touch
 *         a healthy account" property. Hand-derivable setup: 1_500 collateral,
 *         10_000 long at 100_000, 10% maintenance, 2% penalty, ADL band
 *         [1.0, 1.2), ADL fraction 25%.
 */
contract MarginFuzzTest is Test {
    bytes32 constant FEED = bytes32(uint256(1));
    uint256 constant BUCKET = 900;

    MockPyth pyth;
    CanonicalSeries series;
    MockERC20 usdc;
    MarginAccount margin;
    InsuranceFund fund;

    address alice = address(0xA11CE);
    address stranger = address(0xBAD);

    function setUp() public {
        pyth = new MockPyth();
        series = new CanonicalSeries("BTC/USD", FEED, 1, BUCKET, address(pyth), 60);
        usdc = new MockERC20("USD Coin", "USDC", 18);
        (, RefusalGate gate) = deployGate(one(address(series)));
        address predicted = vm.computeCreateAddress(address(this), vm.getNonce(address(this)) + 1);
        fund = new InsuranceFund(address(usdc), predicted);
        margin = new MarginAccount(address(usdc), 1000, address(fund), 200, 1.2e18, 2_500, address(gate));
        vm.warp(1_000_000 * BUCKET);

        usdc.mint(alice, 1_500);
        vm.prank(alice);
        usdc.approve(address(margin), type(uint256).max);
        vm.prank(alice);
        margin.deposit(1_500);
        _record(100_000);
        vm.prank(alice);
        margin.openPosition(address(series), true, 10_000);
    }

    function _record(int64 price) internal {
        pyth.setPrice(FEED, price, 1, -8, block.timestamp);
        series.recordSample();
    }

    function _move(int64 price) internal {
        vm.warp(block.timestamp + BUCKET);
        _record(price);
    }

    function _ledger() internal view {
        assertEq(int256(usdc.balanceOf(address(margin))), int256(margin.totalCollateral()) + margin.counterpartyBalance());
    }

    /// @notice Above the ADL threshold NOBODY but alice can do anything to
    ///         alice's account, whatever they pass.
    function testFuzz_HealthyAccountCannotBeTouchedByAStranger(
        uint64 rawPrice,
        address attacker,
        uint256 positionId,
        uint256 amount
    ) public {
        vm.assume(attacker != alice && attacker != address(this));
        int64 price = int64(uint64(bound(rawPrice, 100_000, 400_000))); // long in profit => healthy
        _move(price);
        assertGe(margin.healthFactor(alice), 1.2e18);

        uint256 collateralBefore = margin.collateralOf(alice);
        (, , uint256 sizeBefore,, bool openBefore) = margin.positionOf(alice, 0);
        uint256 tokensBefore = usdc.balanceOf(alice);

        vm.startPrank(attacker);
        vm.expectRevert();
        margin.liquidate(alice, positionId);
        vm.expectRevert();
        margin.deleverage(alice);
        vm.expectRevert();
        margin.closePosition(positionId); // scoped to msg.sender: attacker has no positions
        vm.expectRevert();
        margin.withdraw(bound(amount, 1, type(uint128).max)); // attacker has no collateral
        vm.stopPrank();

        assertEq(margin.collateralOf(alice), collateralBefore);
        assertEq(usdc.balanceOf(alice), tokensBefore);
        (, , uint256 sizeAfter,, bool openAfter) = margin.positionOf(alice, 0);
        assertEq(sizeAfter, sizeBefore);
        assertEq(openAfter, openBefore);
        _ledger();
    }

    /// @notice Liquidation outcome is exactly the documented arithmetic:
    ///         loss applied to collateral, excess becomes shortfall (flat
    ///         account => fund draw / uncovered), penalty min(2% size,
    ///         what is left) to the fund, liquidator paid nothing.
    function testFuzz_LiquidationArithmetic(uint64 rawPrice, uint256 fundTopUp) public {
        int64 price = int64(uint64(bound(rawPrice, 1_000, 99_999)));
        fundTopUp = bound(fundTopUp, 0, 3_000);
        if (fundTopUp > 0) {
            usdc.mint(address(this), fundTopUp);
            usdc.approve(address(fund), fundTopUp);
            fund.deposit(fundTopUp);
        }
        _move(price);

        int256 pnl = (int256(10_000) * (int256(price) - 100_000)) / 100_000; // <= 0
        uint256 loss = uint256(-pnl);
        bool liquidatable = margin.healthFactor(alice) < 1e18;

        vm.prank(stranger);
        if (!liquidatable) {
            vm.expectRevert(MarginAccount.NotLiquidatable.selector);
            margin.liquidate(alice, 0);
            _ledger();
            return;
        }
        margin.liquidate(alice, 0);

        uint256 applied = loss < 1_500 ? loss : 1_500;
        uint256 shortfall = loss - applied;
        uint256 left = 1_500 - applied;
        uint256 penalty = left < 200 ? left : 200;

        assertEq(margin.collateralOf(alice), left - penalty, "collateral = start - loss - penalty");
        assertEq(margin.debtOf(alice), 0, "flat account: debt is resolved through the fund");
        uint256 covered = fund.totalShortfallCovered();
        assertEq(covered, shortfall < fundTopUp ? shortfall : fundTopUp, "fund pays min(shortfall, balance)");
        assertEq(margin.uncoveredBadDebt(), shortfall - covered);
        assertEq(fund.totalPenaltiesReceived(), penalty);
        assertEq(usdc.balanceOf(stranger), 0, "liquidator is not paid");
        _ledger();
    }

    /// @notice ADL: only in [1.0, 1.2); realizes exactly 25% of the position;
    ///         health rises; equity is preserved up to rounding dust.
    function testFuzz_DeleverageArithmetic(uint64 rawPrice) public {
        int64 price = int64(uint64(bound(rawPrice, 90_000, 110_000)));
        _move(price);

        uint256 h = margin.healthFactor(alice);
        bool inBand = h >= 1e18 && h < 1.2e18;

        vm.prank(stranger);
        if (!inBand) {
            vm.expectRevert(MarginAccount.NotDeleverageable.selector);
            margin.deleverage(alice);
            return;
        }
        int256 equityBefore = _equity();
        (uint256 id, uint256 closed) = margin.deleverage(alice);
        int256 equityAfter = _equity();

        assertEq(id, 0);
        assertEq(closed, 2_500);
        (,, uint256 size,,) = margin.positionOf(alice, 0);
        assertEq(size, 7_500);
        assertGe(margin.healthFactor(alice), h, "health never falls");
        int256 drift = equityAfter - equityBefore;
        assertLe(drift < 0 ? -drift : drift, 1, "equity preserved up to 1 unit of rounding");
        assertEq(usdc.balanceOf(stranger), 0);
        _ledger();
    }

    function _equity() internal view returns (int256) {
        (,, uint256 size, uint256 entry,) = margin.positionOf(alice, 0);
        (,,, int64 close,,) = series.getCandle(series.bucketIndexOf(block.timestamp));
        int256 unrealized = (int256(size) * (int256(close) - int256(entry))) / int256(entry);
        return int256(margin.collateralOf(alice)) - int256(margin.debtOf(alice)) + unrealized;
    }

    /// @notice Deposit/withdraw round trip returns exactly what went in.
    function testFuzz_DepositWithdrawRoundTrip(uint256 amount) public {
        amount = bound(amount, 1, 1_000_000);
        address bob = address(0xB0B);
        usdc.mint(bob, amount);
        vm.startPrank(bob);
        usdc.approve(address(margin), amount);
        margin.deposit(amount);
        assertEq(margin.collateralOf(bob), amount);
        margin.withdraw(amount);
        vm.stopPrank();
        assertEq(usdc.balanceOf(bob), amount);
        assertEq(margin.collateralOf(bob), 0);
        _ledger();
    }
}
