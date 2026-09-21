// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import { ICanonicalSeries } from "./CanonicalSeries.sol";
import { IERC20 } from "./interfaces/IERC20.sol";
import { InsuranceFund } from "./InsuranceFund.sol";
import { RefusalGate } from "./RefusalGate.sol";
import { StrategyRegistry } from "./StrategyRegistry.sol";

/**
 * @title MarginAccount
 * @notice On-chain side of the cross-margin ledger. Off-chain mirror lives at
 *         `packages/backend/convex/accounts.ts` (collateral, exposure by asset
 *         class) and `packages/backend/convex/positions.ts` (asset, side,
 *         size, entry price, liquidation price) — this contract is the
 *         source of truth those two Convex tables reconcile against, so the
 *         field shapes here (asset/side/size/entryPrice) deliberately mirror
 *         theirs.
 *
 * @dev    Per docs/ARCHITECTURE.md's "three layers", this contract is
 *         deliberately stupid: it verifies collateral transfers and does
 *         arithmetic against a `CanonicalSeries` it reads, and nothing else.
 *         It never calls a model, never accepts a bare assertion about a
 *         position's health, and never resolves a liquidation by anything
 *         other than comparing numbers.
 *
 *         PRICE READS ARE HONEST, NOT CONVENIENT: `_currentPrice` only ever
 *         reads the candle recorded for the *current* bucket of the
 *         referenced `CanonicalSeries`. If nobody has called that series'
 *         permissionless `recordSample()` since the bucket rolled over, this
 *         contract reverts (`NoRecentPrice`) rather than falling back to a
 *         stale or interpolated price — the same "never synthesize" rule
 *         `CanonicalSeries` itself enforces. Anyone can make that call; it is
 *         exactly the same permissionless keeper pattern `liquidate` and
 *         `deleverage` use.
 *
 *         RISK ENGINE V1 — three permissionless, arithmetic-only mechanisms
 *         and no trusted operator anywhere in the loop:
 *
 *         1. HEALTH FACTOR. `healthFactor = equity * 1e18 / maintenance`,
 *            where `equity = collateral - debt + sum(unrealized PnL)` and
 *            `maintenance = sum(size * maintenanceMarginBps / 1e4)` over open
 *            positions. Below `LIQUIDATION_THRESHOLD` (1e18) an account is
 *            liquidatable.
 *
 *         2. PARTIAL DE-LEVERAGING (ADL v1) — `deleverage(account)`, callable
 *            by anyone, only while
 *            `LIQUIDATION_THRESHOLD <= healthFactor < adlHealthThreshold`.
 *            It closes exactly `adlFractionBps` of the account's LARGEST open
 *            position (by `size`; lowest position id on a tie) at the current
 *            `CanonicalSeries` price, realizing that slice's PnL. Realizing
 *            PnL does not change equity, but the closed slice no longer
 *            needs maintenance margin, so the health factor rises. The
 *            entry price of the remaining position is unchanged. Both
 *            parameters are immutable and documented in the README; there is
 *            no setter. No penalty is charged for de-leveraging.
 *
 *         3. LIQUIDATION + INSURANCE FUND. `liquidate` closes one whole
 *            position when `healthFactor < LIQUIDATION_THRESHOLD`, charges
 *            `liquidationPenaltyBps` of the position's size (capped at the
 *            collateral that is left after the loss) and sends it to the
 *            `InsuranceFund`. If the realized loss exceeds the account's
 *            collateral, the excess becomes account-level DEBT rather than
 *            being written off, because under cross-margin other open
 *            positions may still carry gains that cover it (writing the excess
 *            off immediately would let the owner keep those gains and hand the
 *            fund the loss). Debt is netted against later realized gains and
 *            repaid first by new deposits. Only when an account has NO open
 *            positions left and debt remains is the debt genuine bad debt:
 *            `InsuranceFund.coverShortfall` is drawn for it, and whatever the
 *            fund cannot cover is recorded in `uncoveredBadDebt` and emitted —
 *            never socialized across other accounts.
 *
 *         LEDGER IDENTITY (tested as an invariant). Every token that enters or
 *         leaves this contract is matched by exactly one ledger movement:
 *
 *             token.balanceOf(this) == totalCollateral + counterpartyBalance
 *
 *         `counterpartyBalance` is the net amount held on behalf of the other
 *         side of every trade: realized losses retained and fund coverage
 *         received, minus realized profits credited. It is NEGATIVE whenever
 *         winners have been credited more than losers have paid in. This
 *         contract has no liquidity pool behind winning trades in this pass,
 *         so a winner's profit is a ledger credit that only becomes
 *         withdrawable to the extent tokens back it (`withdraw` reverts on the
 *         token transfer otherwise, never overpays). That is a named
 *         limitation, not a hidden one; see the README.
 *
 *         RULE-BOUND ACCOUNTS. An account may `bindStrategy(strategyId)` to
 *         a strategy it owns in `StrategyRegistry`. Binding is one-way (no
 *         unbind, no admin — the strategy's own tighten/loosen rules are the
 *         only way its rules ever change). From then on `openPosition` is
 *         closed for that account and the only way to open a position is
 *         `openGuardedPosition`, which requires `RefusalGate.evaluateOnChain`
 *         to pass IN THE SAME TRANSACTION: predicates bound to the strategy's
 *         pinned commitment, series read from the registry, latest bucket
 *         fresh. No approval is stored, so none can be replayed. Refusal is a
 *         success state: a failing evaluation returns `(false, 0)` and opens
 *         nothing. Closing, withdrawing, liquidation and de-leveraging are
 *         never gated — a rule-bound account can always get out, and the
 *         risk engine treats it like any other. Binding is per address: an
 *         owner who wants to trade outside their rules can use another
 *         address; the product enforces your rules on the accounts you bind,
 *         it does not claim to prevent that.
 *
 *         NO ADMIN PATH. No function moves an account's collateral except:
 *         the account's own `deposit`/`withdraw`/`closePosition`, and the
 *         permissionless `liquidate`/`deleverage` arithmetic above, whose
 *         only effects are PnL realization, the liquidation penalty (to the
 *         fund) and fund coverage (from the fund). The liquidator/caller
 *         receives nothing and can direct nothing.
 */
contract MarginAccount {
    struct Position {
        address seriesContract; // CanonicalSeries this position's asset is priced from
        bool isLong;
        uint256 size; // notional, in collateral-token units — integer, explicit decimals, never a float
        uint256 entryPrice; // CanonicalSeries native fixed-point units, captured at open
        bool open;
    }

    /// @notice Fixed-point precision for `healthFactor`. 1e18 == 100% —
    ///         a health factor below this is liquidatable.
    uint256 public constant HEALTH_FACTOR_PRECISION = 1e18;
    uint256 public constant LIQUIDATION_THRESHOLD = HEALTH_FACTOR_PRECISION;
    uint256 public constant BPS_DENOMINATOR = 10_000;

    /// @notice Bounds every loop over an account's open positions so a user
    ///         cannot open enough positions to make their own liquidation run
    ///         out of gas.
    uint256 public constant MAX_OPEN_POSITIONS = 16;

    /// @notice Upper bound on a single position's size. Keeps every
    ///         `int256(size) * priceDiff` product far inside int256.
    uint256 public constant MAX_POSITION_SIZE = type(uint128).max;

    IERC20 public immutable collateralToken;

    /// @notice Maintenance margin requirement per unit of position notional,
    ///         in basis points. Pinned at deployment; there is no function
    ///         anywhere in this contract that can change it later — a mutable
    ///         risk parameter here would be exactly the kind of hidden
    ///         parameter docs/ARCHITECTURE.md and the top-level CLAUDE.md
    ///         forbid. A different risk profile means a new MarginAccount
    ///         deployment, not an admin call on this one.
    uint256 public immutable maintenanceMarginBps;

    /// @notice Where liquidation penalties go and where shortfalls are drawn
    ///         from. Pinned; the fund's own `margin()` must equal this
    ///         contract (checked in the constructor).
    InsuranceFund public immutable insuranceFund;

    /// @notice Gate (and, through it, the registry) a strategy-bound account's
    ///         opens are checked against. Pinned at construction.
    RefusalGate public immutable refusalGate;
    StrategyRegistry public immutable registry;

    /// @notice Share of a liquidated position's `size`, in basis points,
    ///         charged as a penalty and paid to the insurance fund.
    uint256 public immutable liquidationPenaltyBps;

    /// @notice ADL v1 upper bound (exclusive), 1e18-scaled like `healthFactor`.
    ///         `deleverage` only succeeds while
    ///         `LIQUIDATION_THRESHOLD <= healthFactor < adlHealthThreshold`.
    uint256 public immutable adlHealthThreshold;

    /// @notice ADL v1 fraction, in basis points, of the largest open position
    ///         closed by one `deleverage` call.
    uint256 public immutable adlFractionBps;

    /// @notice The strategy an account is bound to; meaningful only when
    ///         `isStrategyBound[account]`.
    mapping(address => uint256) public boundStrategyOf;
    mapping(address => bool) public isStrategyBound;

    mapping(address => uint256) public collateralOf;

    /// @notice Realized losses beyond collateral, awaiting netting against
    ///         later gains, repayment by deposit, or (if the account is flat)
    ///         resolution through the insurance fund. Mutually exclusive with
    ///         `collateralOf`: an account never has both non-zero.
    mapping(address => uint256) public debtOf;

    /// @notice Sum of `collateralOf` over every account.
    uint256 public totalCollateral;

    /// @notice See "LEDGER IDENTITY" above.
    int256 public counterpartyBalance;

    /// @notice Cumulative debt the insurance fund could not cover. Recorded,
    ///         emitted, never socialized.
    uint256 public uncoveredBadDebt;

    mapping(address => Position[]) private _positions;
    /// @dev Ids of each account's currently open positions (unordered). Every
    ///      risk loop iterates this, not `_positions`, so closed positions
    ///      cost nothing and the loop is bounded by `MAX_OPEN_POSITIONS`.
    mapping(address => uint256[]) private _openIds;

    event Deposited(address indexed account, uint256 amount);
    event Withdrawn(address indexed account, uint256 amount);
    event PositionOpened(
        address indexed account,
        uint256 indexed positionId,
        address indexed seriesContract,
        bool isLong,
        uint256 size,
        uint256 entryPrice
    );
    event PositionClosed(
        address indexed account, uint256 indexed positionId, uint256 exitPrice, int256 pnl, bool wasLiquidation
    );
    event PositionDeleveraged(
        address indexed account,
        uint256 indexed positionId,
        uint256 closedSize,
        uint256 remainingSize,
        uint256 exitPrice,
        int256 pnl,
        uint256 healthFactorBefore,
        uint256 healthFactorAfter
    );
    event LiquidationPenaltyCharged(address indexed account, uint256 indexed positionId, uint256 penalty);
    event StrategyBound(address indexed account, uint256 indexed strategyId);
    event DebtIncurred(address indexed account, uint256 amount);
    event DebtRepaid(address indexed account, uint256 amount);
    event BadDebtResolved(address indexed account, uint256 debt, uint256 coveredByFund, uint256 uncovered);

    error ZeroAmount();
    error ZeroSize();
    error SizeTooLarge();
    error TooManyOpenPositions();
    error NoRecentPrice();
    error InvalidPrice();
    error PositionNotFound();
    error PositionNotOpen();
    error NotPositionOwner();
    error InsufficientCollateral();
    error NotLiquidatable();
    error NotDeleverageable();
    error NothingToDeleverage();
    error TransferFailed();
    error NotStrategyOwner();
    error AlreadyBound();
    error NotBound();
    error AccountIsStrategyBound();

    constructor(
        address collateralToken_,
        uint256 maintenanceMarginBps_,
        address insuranceFund_,
        uint256 liquidationPenaltyBps_,
        uint256 adlHealthThreshold_,
        uint256 adlFractionBps_,
        address refusalGate_
    ) {
        require(collateralToken_ != address(0), "collateral token required");
        require(maintenanceMarginBps_ > 0 && maintenanceMarginBps_ <= BPS_DENOMINATOR, "invalid maintenance bps");
        require(insuranceFund_ != address(0), "insurance fund required");
        require(liquidationPenaltyBps_ <= BPS_DENOMINATOR, "invalid penalty bps");
        require(
            adlHealthThreshold_ > LIQUIDATION_THRESHOLD && adlHealthThreshold_ <= 3 * HEALTH_FACTOR_PRECISION,
            "invalid adl threshold"
        );
        require(adlFractionBps_ > 0 && adlFractionBps_ < BPS_DENOMINATOR, "invalid adl fraction");
        require(refusalGate_ != address(0), "refusal gate required");

        InsuranceFund fund = InsuranceFund(insuranceFund_);
        require(fund.margin() == address(this), "fund bound to another margin");
        require(address(fund.collateralToken()) == collateralToken_, "fund token mismatch");

        collateralToken = IERC20(collateralToken_);
        maintenanceMarginBps = maintenanceMarginBps_;
        insuranceFund = fund;
        liquidationPenaltyBps = liquidationPenaltyBps_;
        adlHealthThreshold = adlHealthThreshold_;
        adlFractionBps = adlFractionBps_;
        refusalGate = RefusalGate(refusalGate_);
        registry = RefusalGate(refusalGate_).registry();
    }

    /// @notice Deposits collateral into the caller's own account. Anyone may
    ///         deposit for themselves; nobody may deposit on behalf of
    ///         another address, so there is no path to inflate someone else's
    ///         ledger without their own token approval. Any outstanding debt
    ///         is repaid from the deposit first.
    function deposit(uint256 amount) external {
        if (amount == 0) revert ZeroAmount();

        uint256 debt = debtOf[msg.sender];
        uint256 repay = amount < debt ? amount : debt;
        if (repay > 0) {
            debtOf[msg.sender] = debt - repay;
            counterpartyBalance += int256(repay);
            emit DebtRepaid(msg.sender, repay);
        }
        uint256 credit = amount - repay;
        collateralOf[msg.sender] += credit;
        totalCollateral += credit;

        bool ok = collateralToken.transferFrom(msg.sender, address(this), amount);
        if (!ok) revert TransferFailed();
        emit Deposited(msg.sender, amount);
    }

    /// @notice Withdraws collateral from the caller's own account. Reverts if
    ///         the withdrawal would leave any open position under-margined —
    ///         pure arithmetic against the account's own recorded positions,
    ///         never a judgment call.
    function withdraw(uint256 amount) external {
        if (amount == 0) revert ZeroAmount();
        if (amount > collateralOf[msg.sender]) revert InsufficientCollateral();

        collateralOf[msg.sender] -= amount;
        totalCollateral -= amount;
        if (_maintenanceRequirement(msg.sender) > 0 && healthFactor(msg.sender) < LIQUIDATION_THRESHOLD) {
            revert InsufficientCollateral();
        }

        bool ok = collateralToken.transfer(msg.sender, amount);
        if (!ok) revert TransferFailed();
        emit Withdrawn(msg.sender, amount);
    }

    /// @notice Opens a position for the caller, recording entry price from a
    ///         `CanonicalSeries` read taken right now (see contract-level
    ///         NatSpec on why that read can revert). Reverts if the resulting
    ///         account would already be below the liquidation threshold —
    ///         this contract will not open a position that is unhealthy from
    ///         the first block. Not available to a strategy-bound account:
    ///         those open through `openGuardedPosition`.
    function openPosition(address seriesContract, bool isLong, uint256 size) external returns (uint256 positionId) {
        if (isStrategyBound[msg.sender]) revert AccountIsStrategyBound();
        return _open(msg.sender, seriesContract, isLong, size);
    }

    /// @notice One-way: binds the caller's account to a strategy the caller
    ///         owns. See "RULE-BOUND ACCOUNTS" in the contract NatSpec.
    function bindStrategy(uint256 strategyId) external {
        if (isStrategyBound[msg.sender]) revert AlreadyBound();
        if (registry.ownerOf(strategyId) != msg.sender) revert NotStrategyOwner();
        isStrategyBound[msg.sender] = true;
        boundStrategyOf[msg.sender] = strategyId;
        emit StrategyBound(msg.sender, strategyId);
    }

    /// @notice Opens a position for a strategy-bound account, only if the
    ///         strategy's pinned predicates pass `RefusalGate.evaluateOnChain`
    ///         in this same transaction. The position is priced from the
    ///         strategy's own pinned series. A failing evaluation is a
    ///         refusal, not an error: returns `(false, 0)`, opens nothing, and
    ///         the gate's `TradeRefused` event names the predicate and number.
    /// @param predicates The bound strategy's predicates exactly as pinned.
    function openGuardedPosition(bool isLong, uint256 size, RefusalGate.PredicateDefinition[] calldata predicates)
        external
        returns (bool opened, uint256 positionId)
    {
        if (!isStrategyBound[msg.sender]) revert NotBound();
        uint256 strategyId = boundStrategyOf[msg.sender];
        if (!refusalGate.evaluateOnChain(strategyId, isLong, predicates)) return (false, 0);
        positionId = _open(msg.sender, registry.activeSeries(strategyId), isLong, size);
        return (true, positionId);
    }

    function _open(address account, address seriesContract, bool isLong, uint256 size)
        internal
        returns (uint256 positionId)
    {
        if (size == 0) revert ZeroSize();
        if (size > MAX_POSITION_SIZE) revert SizeTooLarge();
        require(seriesContract != address(0), "series required");
        if (_openIds[account].length >= MAX_OPEN_POSITIONS) revert TooManyOpenPositions();

        uint256 entryPrice = uint256(_currentPrice(seriesContract));

        Position[] storage positions = _positions[account];
        positionId = positions.length;
        positions.push(
            Position({ seriesContract: seriesContract, isLong: isLong, size: size, entryPrice: entryPrice, open: true })
        );
        _openIds[account].push(positionId);

        if (healthFactor(account) < LIQUIDATION_THRESHOLD) revert InsufficientCollateral();

        emit PositionOpened(account, positionId, seriesContract, isLong, size, entryPrice);
    }

    /// @notice Self-service close: only the account owner may voluntarily
    ///         realize a position's PnL. Contrast with `liquidate`, which is
    ///         permissionless but gated on the account actually being
    ///         unhealthy — nobody can close someone else's position through
    ///         this path.
    function closePosition(uint256 positionId) external {
        Position storage p = _position(msg.sender, positionId);
        if (!p.open) revert PositionNotOpen();

        int256 exitPrice = _currentPrice(p.seriesContract);
        int256 pnl = _pnl(p.size, p.entryPrice, exitPrice, p.isLong);
        _closeWhole(msg.sender, positionId, p);
        _realize(msg.sender, pnl);
        emit PositionClosed(msg.sender, positionId, uint256(exitPrice), pnl, false);
        _resolveIfFlat(msg.sender);
    }

    /// @notice Permissionless liquidation. Callable by anyone, for any
    ///         account and position, but only ever succeeds when
    ///         `healthFactor(account)` is actually below the threshold at the
    ///         moment of the call. There is no allowlist of who may call this
    ///         and no way for the account owner to block it. The caller
    ///         receives nothing: the penalty goes to the insurance fund.
    function liquidate(address account, uint256 positionId) external {
        Position storage p = _position(account, positionId);
        if (!p.open) revert PositionNotOpen();
        if (healthFactor(account) >= LIQUIDATION_THRESHOLD) revert NotLiquidatable();

        int256 exitPrice = _currentPrice(p.seriesContract);
        uint256 size = p.size;
        int256 pnl = _pnl(size, p.entryPrice, exitPrice, p.isLong);

        _closeWhole(account, positionId, p);
        _realize(account, pnl);
        _chargePenalty(account, positionId, size);
        emit PositionClosed(account, positionId, uint256(exitPrice), pnl, true);
        _resolveIfFlat(account);
    }

    /// @notice ADL v1: permissionless partial de-leveraging. Succeeds only
    ///         while `LIQUIDATION_THRESHOLD <= healthFactor(account) <
    ///         adlHealthThreshold`; closes `adlFractionBps` of the account's
    ///         largest open position at the current `CanonicalSeries` price.
    ///         See contract-level NatSpec for the exact rule.
    /// @return positionId The position that was reduced.
    /// @return closedSize The notional size that was closed.
    function deleverage(address account) external returns (uint256 positionId, uint256 closedSize) {
        uint256 healthBefore = healthFactor(account);
        if (healthBefore < LIQUIDATION_THRESHOLD || healthBefore >= adlHealthThreshold) revert NotDeleverageable();

        positionId = _largestOpenPosition(account);
        Position storage p = _positions[account][positionId];

        closedSize = (p.size * adlFractionBps) / BPS_DENOMINATOR;
        if (closedSize == 0) revert NothingToDeleverage();

        int256 exitPrice = _currentPrice(p.seriesContract);
        int256 pnl = _pnl(closedSize, p.entryPrice, exitPrice, p.isLong);

        p.size -= closedSize;
        _realize(account, pnl);

        emit PositionDeleveraged(
            account, positionId, closedSize, p.size, uint256(exitPrice), pnl, healthBefore, healthFactor(account)
        );
    }

    /// @notice Distance to liquidation, pure arithmetic over this account's
    ///         own recorded positions and each position's `CanonicalSeries`
    ///         current-bucket price. No external call beyond those series
    ///         reads. 1e18 == 100%; below that is liquidatable. An account
    ///         with no open positions is maximally healthy by definition
    ///         (nothing to maintain margin against).
    function healthFactor(address account) public view returns (uint256) {
        uint256 maintenanceRequirement = _maintenanceRequirement(account);
        if (maintenanceRequirement == 0) return type(uint256).max;

        int256 equity = int256(collateralOf[account]) - int256(debtOf[account]);
        uint256[] storage ids = _openIds[account];
        Position[] storage positions = _positions[account];
        for (uint256 i = 0; i < ids.length; i++) {
            Position storage p = positions[ids[i]];
            int256 currentPrice = _currentPrice(p.seriesContract);
            equity += _pnl(p.size, p.entryPrice, currentPrice, p.isLong);
        }

        if (equity <= 0) return 0;
        return (uint256(equity) * HEALTH_FACTOR_PRECISION) / maintenanceRequirement;
    }

    function positionOf(address account, uint256 positionId)
        external
        view
        returns (address seriesContract, bool isLong, uint256 size, uint256 entryPrice, bool open)
    {
        Position storage p = _position(account, positionId);
        return (p.seriesContract, p.isLong, p.size, p.entryPrice, p.open);
    }

    function positionCount(address account) external view returns (uint256) {
        return _positions[account].length;
    }

    function openPositionCount(address account) external view returns (uint256) {
        return _openIds[account].length;
    }

    function _maintenanceRequirement(address account) internal view returns (uint256 requirement) {
        uint256[] storage ids = _openIds[account];
        Position[] storage positions = _positions[account];
        for (uint256 i = 0; i < ids.length; i++) {
            requirement += (positions[ids[i]].size * maintenanceMarginBps) / BPS_DENOMINATOR;
        }
    }

    function _largestOpenPosition(address account) internal view returns (uint256 bestId) {
        uint256[] storage ids = _openIds[account];
        Position[] storage positions = _positions[account];
        uint256 bestSize = 0;
        bool found = false;
        for (uint256 i = 0; i < ids.length; i++) {
            uint256 id = ids[i];
            uint256 size = positions[id].size;
            // Largest size wins; on a tie the lowest position id wins, so the
            // choice never depends on the (unordered) `_openIds` layout.
            if (!found || size > bestSize || (size == bestSize && id < bestId)) {
                bestId = id;
                bestSize = size;
                found = true;
            }
        }
    }

    /// @dev Marks a position closed and removes it from the open-id list.
    function _closeWhole(address account, uint256 positionId, Position storage p) internal {
        p.open = false;
        uint256[] storage ids = _openIds[account];
        uint256 n = ids.length;
        for (uint256 i = 0; i < n; i++) {
            if (ids[i] == positionId) {
                ids[i] = ids[n - 1];
                ids.pop();
                break;
            }
        }
    }

    /// @dev Moves realized PnL into the ledger. Gains net against debt first;
    ///      losses consume collateral first and turn any excess into debt.
    ///      Every branch preserves the ledger identity (see contract NatSpec).
    function _realize(address account, int256 pnl) internal {
        if (pnl > 0) {
            uint256 gain = uint256(pnl);
            uint256 debt = debtOf[account];
            uint256 repay = gain < debt ? gain : debt;
            if (repay > 0) debtOf[account] = debt - repay;
            uint256 credit = gain - repay;
            if (credit > 0) {
                collateralOf[account] += credit;
                totalCollateral += credit;
                counterpartyBalance -= int256(credit);
            }
        } else if (pnl < 0) {
            uint256 loss = uint256(-pnl);
            uint256 collateral = collateralOf[account];
            uint256 applied = loss < collateral ? loss : collateral;
            if (applied > 0) {
                collateralOf[account] = collateral - applied;
                totalCollateral -= applied;
                counterpartyBalance += int256(applied);
            }
            uint256 excess = loss - applied;
            if (excess > 0) {
                debtOf[account] += excess;
                emit DebtIncurred(account, excess);
            }
        }
    }

    /// @dev Liquidation penalty: `liquidationPenaltyBps` of the closed size,
    ///      taken only from collateral that survived the loss, sent to the
    ///      insurance fund.
    function _chargePenalty(address account, uint256 positionId, uint256 size) internal {
        uint256 penalty = (size * liquidationPenaltyBps) / BPS_DENOMINATOR;
        uint256 collateral = collateralOf[account];
        if (penalty > collateral) penalty = collateral;
        if (penalty == 0) return;

        collateralOf[account] = collateral - penalty;
        totalCollateral -= penalty;

        bool ok = collateralToken.transfer(address(insuranceFund), penalty);
        if (!ok) revert TransferFailed();
        insuranceFund.recordPenalty(penalty);
        emit LiquidationPenaltyCharged(account, positionId, penalty);
    }

    /// @dev If the account has no open positions left but still owes debt,
    ///      nothing else can ever net against it: draw the insurance fund for
    ///      it and record any remainder as uncovered bad debt.
    function _resolveIfFlat(address account) internal {
        uint256 debt = debtOf[account];
        if (debt == 0 || _openIds[account].length != 0) return;

        debtOf[account] = 0;
        uint256 covered = insuranceFund.coverShortfall(debt);
        counterpartyBalance += int256(covered);
        uint256 uncovered = debt - covered;
        if (uncovered > 0) uncoveredBadDebt += uncovered;
        emit BadDebtResolved(account, debt, covered, uncovered);
    }

    function _pnl(uint256 size, uint256 entryPrice, int256 currentPrice, bool isLong) internal pure returns (int256) {
        int256 entry = int256(entryPrice);
        int256 diff = currentPrice - entry;
        int256 pnl = (int256(size) * diff) / entry;
        return isLong ? pnl : -pnl;
    }

    /// @dev Only ever reads the *current* bucket's candle — see contract-level
    ///      NatSpec. Never falls back to an older bucket, never interpolates.
    function _currentPrice(address seriesContract) internal view returns (int256) {
        ICanonicalSeries s = ICanonicalSeries(seriesContract);
        uint256 bucket = s.bucketIndexOf(block.timestamp);
        (,,, int64 close,, bool recorded) = s.getCandle(bucket);
        if (!recorded) revert NoRecentPrice();
        if (close <= 0) revert InvalidPrice();
        return int256(close);
    }

    function _position(address account, uint256 positionId) internal view returns (Position storage) {
        Position[] storage positions = _positions[account];
        if (positionId >= positions.length) revert PositionNotFound();
        return positions[positionId];
    }
}
