// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import { StrategyRegistry } from "./StrategyRegistry.sol";
import { IERC20 } from "./interfaces/IERC20.sol";
import { SafeERC20 } from "./SafeERC20.sol";
import { ReentrancyGuard } from "./ReentrancyGuard.sol";
import { RefusalGate } from "./RefusalGate.sol";

/**
 * @title GuardedVault
 * @notice The "Guarded AI Agent Vault": a user deposits collateral into a
 *         vault tied to one `StrategyRegistry` strategy (by `strategyId` /
 *         its pinned `specHash`), and every proposed trade is checked against
 *         two immutable guardrails before it is allowed through:
 *
 *           1. An on-chain asset whitelist, fixed at vault creation. This is
 *              the literal, on-chain form of "cannot buy illiquid meme coins
 *              to drain funds" — there is no function anywhere in this
 *              contract that adds an asset to the whitelist after
 *              construction. Trading a different asset set means deploying a
 *              new vault, not calling an admin function on this one.
 *           2. A daily drawdown cap (`maxDailyDrawdownBps`), also immutable,
 *              checked as pure arithmetic against this vault's own recorded
 *              balance history (a per-UTC-day snapshot of `totalCollateral`
 *              taken the first time a trade is proposed that day) and its
 *              own cumulative realized P&L for that day.
 *
 * @dev    Per docs/ARCHITECTURE.md's "three layers" and the top-level
 *         CLAUDE.md hard rule "the contract never calls a model": both checks
 *         above are arithmetic over on-chain state, nothing else. Neither
 *         check ever calls an LLM, an oracle-of-judgment, or an off-chain
 *         "trust me" of any kind.
 *
 *         REFUSAL IS A SUCCESS STATE (CLAUDE.md hard rule): when a proposed
 *         trade fails either guardrail, `proposeTrade` does **not** revert —
 *         it returns `false` and emits `TradeRefused`, mirroring
 *         `RefusalGate.sol`'s `TradeProposed`/`TradeRefused` event pair
 *         exactly for this reason. A guardrail block is not an error
 *         condition to be styled as one; it is the product working as
 *         designed. `NotAuthorized` (wrong caller) is the only genuine error
 *         path here, because it is a caller mistake, not a guardrail refusal.
 *
 *         PREDICATE SATISFACTION IS ENFORCED HERE, IN THE SAME TRANSACTION:
 *         `proposeTrade` calls `RefusalGate.evaluateOnChain(strategyId,
 *         isLong, predicates)` and honours only the `true` it returns. The series is
 *         the strategy's own pinned series (read from `StrategyRegistry`, not
 *         supplied by the caller), and the predicates must hash to the
 *         strategy's pinned commitment, so a proposer cannot substitute easier
 *         rules. There is no stored approval to replay. What is still
 *         attested, exactly like before: `projectedPnL` for the trade being
 *         proposed, which this contract has no way to verify on its own (it is
 *         not a predicate-satisfaction question, it is "what will this
 *         trade's P&L impact be", which requires either a live execution venue
 *         or an oracle of judgment — neither belongs on-chain per the
 *         top-level CLAUDE.md hard rule). If both guardrails and the
 *         predicate check pass, that attested figure is realized directly into
 *         this vault's daily P&L ledger. Wiring `proposeTrade` to actual
 *         execution against Perpl/Kuru remains explicitly out of scope for
 *         this pass. No admin function exists to skip any of these wiring
 *         gaps; closing one means shipping the missing piece, not adding an
 *         override.
 *
         WHY A SEPARATE EVENT LOG FOR THE PREDICATE CHECK: `proposeTrade`
 *         calls `refusalGate.evaluateOnChain`, which emits its own
 *         `TradeProposed`/`TradeRefused` on `RefusalGate` carrying the exact
 *         failing predicate's `symbol` and `decidingValue` — "evidence
 *         reachable in one tap" (top-level CLAUDE.md's definition of done)
 *         means that log, not a duplicate of it here. This contract's own
 *         `TradeRefused` for that case uses the generic reason
 *         `"PREDICATE_NOT_SATISFIED"` with `decidingValue == 0`; the specific
 *         predicate and number are on `RefusalGate`'s log from the same
 *         transaction.
 *
 *         NO ADMIN OVERRIDE, EVER: there is no owner-only function that can
 *         change the whitelist or `maxDailyDrawdownBps` after construction.
 *         This is deliberate, not an oversight — matching the "no override,
 *         no admin key, no support escape hatch" invariant from
 *         docs/ARCHITECTURE.md and the top-level CLAUDE.md. If a user wants
 *         different guardrails, they deploy a new `GuardedVault`. That is a
 *         feature of this contract, not a limitation to be patched later.
 */
contract GuardedVault is ReentrancyGuard {
    uint256 public constant BPS_DENOMINATOR = 10_000;
    uint256 public constant SECONDS_PER_DAY = 1 days;

    IERC20 public immutable collateralToken;

    /// @notice The vault's owner/depositor. May always call `proposeTrade`
    ///         itself, in addition to `strategyExecutor`.
    address public immutable owner;

    /// @notice The address authorized to submit trade proposals on the
    ///         owner's behalf — e.g. an AI agent's signing key. Distinct from
    ///         `owner` so a compromised or misbehaving executor key can never
    ///         withdraw funds, only propose trades that still have to clear
    ///         both guardrails.
    address public immutable strategyExecutor;

    /// @notice The strategy this vault is bound to, and the `RefusalGate`
    ///         `proposeTrade` checks every trade against. Both are immutable,
    ///         same "no admin override" reasoning as the whitelist and
    ///         drawdown cap: a vault bound to a different strategy or gate is
    ///         a new vault, not a setter call on this one. The series is not
    ///         stored here: it is whatever series the strategy's pinned spec
    ///         names (`registry.activeSeries(strategyId)`), so it can only
    ///         change through the registry's tighten/loosen rules.
    StrategyRegistry public immutable registry;
    uint256 public immutable strategyId;
    RefusalGate public immutable refusalGate;

    /// @notice Maximum realized loss allowed in a single UTC day, in basis
    ///         points of the day's opening `totalCollateral`. Immutable —
    ///         see contract-level NatSpec on why there is no setter.
    uint256 public immutable maxDailyDrawdownBps;

    mapping(bytes32 => bool) private _whitelisted;
    bytes32[] public whitelistedAssetIds;

    uint256 public totalCollateral;

    /// @dev UTC day (`block.timestamp / 1 days`) -> cumulative realized PnL
    ///      proposed and allowed so far that day. Can be negative.
    mapping(uint256 => int256) public dailyRealizedPnL;

    /// @dev UTC day -> `totalCollateral` snapshot taken the first time a
    ///      trade is proposed that day. This, not a live balance, is the
    ///      "vault's own recorded balance history" the drawdown check reads.
    mapping(uint256 => uint256) public dailyReferenceBalance;
    mapping(uint256 => bool) private _dayInitialized;

    event Deposited(address indexed from, uint256 amount);
    event Withdrawn(address indexed to, uint256 amount);
    event TradeProposed(
        bytes32 indexed assetId, address indexed proposer, bool isLong, uint256 size, int256 projectedPnL
    );
    event TradeRefused(bytes32 indexed assetId, address indexed proposer, bytes32 reason, int256 decidingValue);

    error NotAuthorized();
    error ZeroAmount();
    error InsufficientBalance();
    error EmptyWhitelist();
    error InvalidDrawdownBps();
    error TransferFailed();

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotAuthorized();
        _;
    }

    modifier onlyExecutorOrOwner() {
        if (msg.sender != owner && msg.sender != strategyExecutor) revert NotAuthorized();
        _;
    }

    constructor(
        address collateralToken_,
        address owner_,
        address strategyExecutor_,
        address registry_,
        uint256 strategyId_,
        bytes32[] memory whitelistedAssetIds_,
        uint256 maxDailyDrawdownBps_,
        address refusalGate_
    ) {
        require(collateralToken_ != address(0), "collateral token required");
        require(owner_ != address(0), "owner required");
        require(strategyExecutor_ != address(0), "executor required");
        require(registry_ != address(0), "registry required");
        require(refusalGate_ != address(0), "refusal gate required");
        if (whitelistedAssetIds_.length == 0) revert EmptyWhitelist();
        if (maxDailyDrawdownBps_ == 0 || maxDailyDrawdownBps_ > BPS_DENOMINATOR) revert InvalidDrawdownBps();

        collateralToken = IERC20(collateralToken_);
        owner = owner_;
        strategyExecutor = strategyExecutor_;
        registry = StrategyRegistry(registry_);
        strategyId = strategyId_;
        maxDailyDrawdownBps = maxDailyDrawdownBps_;
        refusalGate = RefusalGate(refusalGate_);

        for (uint256 i = 0; i < whitelistedAssetIds_.length; i++) {
            bytes32 id = whitelistedAssetIds_[i];
            require(id != bytes32(0), "invalid asset id");
            if (!_whitelisted[id]) {
                _whitelisted[id] = true;
                whitelistedAssetIds.push(id);
            }
        }
    }

    function isWhitelisted(bytes32 assetId) public view returns (bool) {
        return _whitelisted[assetId];
    }

    function whitelistLength() external view returns (uint256) {
        return whitelistedAssetIds.length;
    }

    /// @notice Deposits collateral. Anyone may top up the vault, but only
    ///         `owner` may withdraw — matching how deposits work everywhere
    ///         else in this package (adding funds is never gated).
    function deposit(uint256 amount) external nonReentrant {
        if (amount == 0) revert ZeroAmount();
        totalCollateral += amount;
        SafeERC20.safeTransferFromExact(collateralToken, msg.sender, address(this), amount);
        emit Deposited(msg.sender, amount);
    }

    function withdraw(uint256 amount) external nonReentrant onlyOwner {
        if (amount == 0) revert ZeroAmount();
        if (amount > totalCollateral) revert InsufficientBalance();
        totalCollateral -= amount;
        SafeERC20.safeTransfer(collateralToken, msg.sender, amount);
        emit Withdrawn(msg.sender, amount);
    }

    /// @notice Proposes a trade against this vault's whitelist and drawdown
    ///         guardrails, plus a real, on-chain predicate check against the
    ///         bound strategy's PINNED rules — three checks. Callable only by
    ///         `owner` or `strategyExecutor` (`NotAuthorized` reverts for
    ///         anyone else — a genuine caller error, not a guardrail
    ///         refusal). A whitelist, predicate or drawdown failure does NOT
    ///         revert: it emits `TradeRefused` and returns `false`. The
    ///         predicate check reverts (via `RefusalGate`) only for setup
    ///         errors: predicates that do not hash to the pinned commitment
    ///         (`CommitmentMismatch`), a stale series (`StaleSeries`), or a
    ///         timeframe mismatch. See contract-level NatSpec for why the
    ///         failing predicate's symbol/value is on `RefusalGate`'s event
    ///         log rather than duplicated onto this one.
    /// @param assetId Identifier of the asset being traded (e.g.
    ///        `keccak256("BTC-USD")`), checked against the immutable
    ///        whitelist set at construction.
    /// @param isLong Direction of the proposed trade. Recorded in the event
    ///        log only in this pass.
    /// @param size Notional size of the proposed trade, in collateral-token
    ///        units. Recorded in the event log only in this pass.
    /// @param projectedPnL The attested realized-PnL impact of this trade,
    ///        signed. Still caller-supplied — see contract-level NatSpec.
    /// @param predicates The bound strategy's predicates exactly as pinned:
    ///        they must hash to the strategy's committed value.
    /// @return allowed True if the whitelist, predicate and drawdown checks
    ///         all passed and `TradeProposed` was emitted; false if
    ///         `TradeRefused` was emitted instead.
    function proposeTrade(
        bytes32 assetId,
        bool isLong,
        uint256 size,
        int256 projectedPnL,
        RefusalGate.PredicateDefinition[] calldata predicates
    ) external onlyExecutorOrOwner nonReentrant returns (bool allowed) {
        uint256 day = _currentDay();
        _ensureDayInitialized(day);

        if (!_whitelisted[assetId]) {
            emit TradeRefused(assetId, msg.sender, "ASSET_NOT_WHITELISTED", 0);
            return false;
        }

        bool predicatesSatisfied = refusalGate.evaluateOnChain(strategyId, isLong, predicates);
        if (!predicatesSatisfied) {
            emit TradeRefused(assetId, msg.sender, "PREDICATE_NOT_SATISFIED", 0);
            return false;
        }

        int256 projectedCumulative = dailyRealizedPnL[day] + projectedPnL;
        uint256 referenceBalance = dailyReferenceBalance[day];
        int256 maxLoss = -int256((referenceBalance * maxDailyDrawdownBps) / BPS_DENOMINATOR);

        if (projectedCumulative < maxLoss) {
            emit TradeRefused(assetId, msg.sender, "DAILY_DRAWDOWN_EXCEEDED", projectedCumulative);
            return false;
        }

        dailyRealizedPnL[day] = projectedCumulative;
        emit TradeProposed(assetId, msg.sender, isLong, size, projectedPnL);
        return true;
    }

    function _currentDay() internal view returns (uint256) {
        return block.timestamp / SECONDS_PER_DAY;
    }

    function _ensureDayInitialized(uint256 day) internal {
        if (!_dayInitialized[day]) {
            dailyReferenceBalance[day] = totalCollateral;
            _dayInitialized[day] = true;
        }
    }
}
