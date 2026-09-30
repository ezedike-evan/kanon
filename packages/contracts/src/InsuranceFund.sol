// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import { IERC20 } from "./interfaces/IERC20.sol";
import { SafeERC20 } from "./SafeERC20.sol";
import { ReentrancyGuard } from "./ReentrancyGuard.sol";

/**
 * @title InsuranceFund
 * @notice Backstop for `MarginAccount`'s bad-debt case: when a liquidation
 *         realizes a loss larger than the liquidated account's collateral, the
 *         difference (the "shortfall") is paid from this fund into the
 *         `MarginAccount`, so the loss the account could not cover is still
 *         backed by real tokens rather than silently vanishing.
 *
 * @dev    INFLOWS: (1) the liquidation penalty `MarginAccount` transfers here
 *         on every liquidation (`recordPenalty`), and (2) explicit `deposit`s
 *         by anyone.
 *
 *         OUTFLOW: exactly one, `coverShortfall`, callable only by the
 *         `MarginAccount` this fund is bound to, sending tokens only to that
 *         same `MarginAccount`. There is no owner, no admin, no governance
 *         hook and no withdrawal function of any kind — anything that enters
 *         this contract can only leave as a shortfall payment for a
 *         liquidation the margin arithmetic itself produced. This is the
 *         "no override, no admin path" rule from docs/ARCHITECTURE.md applied
 *         to a pot of money, which is where an escape hatch is most tempting.
 *
 *         BINDING WITHOUT A PRIVILEGED ROLE: the `MarginAccount` address is an
 *         immutable constructor argument. `MarginAccount` and this fund
 *         reference each other, so the deploy script predicts the
 *         `MarginAccount`'s CREATE address (`vm.computeCreateAddress`) and
 *         `MarginAccount`'s constructor asserts `fund.margin() == address(this)`.
 *         A fund bound to any other address simply cannot be used by a
 *         `MarginAccount`, and no setter exists to re-bind it.
 *
 *         COVERAGE IS CAPPED AT THE BALANCE, NEVER SOCIALIZED: if the fund
 *         holds less than the shortfall it pays what it has and returns the
 *         amount actually covered. The remainder is bad debt, surfaced by
 *         `MarginAccount` as an event and a counter (`uncoveredBadDebt`). This
 *         v1 does not socialize the remainder across other accounts — doing so
 *         would move one user's collateral to cover another's loss, which is
 *         the opposite of the "nobody can move your funds except through
 *         documented arithmetic" property this package holds itself to.
 *
 *         Arithmetic only. Nothing here calls a model, an oracle or an
 *         off-chain service.
 */
contract InsuranceFund is ReentrancyGuard {
    IERC20 public immutable collateralToken;

    /// @notice The only address allowed to draw from this fund, and the only
    ///         address a draw can be sent to. Pinned at construction.
    address public immutable margin;

    /// @notice Lifetime counters, for the indexer and for tests. The live
    ///         balance is always `collateralToken.balanceOf(address(this))`,
    ///         so a stray direct transfer to the fund strengthens it rather
    ///         than desyncing any ledger.
    uint256 public totalPenaltiesReceived;
    uint256 public totalDeposited;
    uint256 public totalShortfallCovered;

    event Deposited(address indexed from, uint256 amount);
    event PenaltyReceived(uint256 amount);
    event ShortfallCovered(uint256 requested, uint256 covered);

    error ZeroAmount();
    error NotMargin();
    error TransferFailed();

    constructor(address collateralToken_, address margin_) {
        require(collateralToken_ != address(0), "collateral token required");
        require(margin_ != address(0), "margin required");
        collateralToken = IERC20(collateralToken_);
        margin = margin_;
    }

    /// @notice Explicit top-up. Anyone may add to the fund; nobody may take
    ///         from it.
    function deposit(uint256 amount) external nonReentrant {
        if (amount == 0) revert ZeroAmount();
        totalDeposited += amount;
        SafeERC20.safeTransferFromExact(collateralToken, msg.sender, address(this), amount);
        emit Deposited(msg.sender, amount);
    }

    /// @notice Called by `MarginAccount` right after it transfers a
    ///         liquidation penalty here. Bookkeeping and an event only — it
    ///         moves no tokens itself, and it cannot be used to inflate the
    ///         balance because coverage is computed from the token balance.
    function recordPenalty(uint256 amount) external {
        if (msg.sender != margin) revert NotMargin();
        totalPenaltiesReceived += amount;
        emit PenaltyReceived(amount);
    }

    /// @notice Pays up to `amount` to the bound `MarginAccount` to cover a
    ///         liquidation shortfall. Returns what was actually paid, which is
    ///         less than `amount` only when the fund's balance is.
    function coverShortfall(uint256 amount) external nonReentrant returns (uint256 covered) {
        if (msg.sender != margin) revert NotMargin();
        uint256 available = collateralToken.balanceOf(address(this));
        covered = amount < available ? amount : available;

        totalShortfallCovered += covered;
        emit ShortfallCovered(amount, covered);

        if (covered > 0) {
            SafeERC20.safeTransfer(collateralToken, margin, covered);
        }
    }

    /// @notice Tokens currently available to cover shortfalls.
    function balance() external view returns (uint256) {
        return collateralToken.balanceOf(address(this));
    }
}
