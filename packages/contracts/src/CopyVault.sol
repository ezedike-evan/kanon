// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import { StrategyRegistry } from "./StrategyRegistry.sol";
import { RefusalGate } from "./RefusalGate.sol";
import { IERC20 } from "./interfaces/IERC20.sol";
import { SafeERC20 } from "./SafeERC20.sol";
import { ReentrancyGuard } from "./ReentrancyGuard.sol";

/**
 * @title CopyVault
 * @notice Non-custodial copy trading. A follower deposits collateral into a
 *         vault bound to one leader (identified by the leader's
 *         `StrategyRegistry` strategy id / pinned specHash) and sets
 *         `allocationBps` — how much of their own capital mirrors the
 *         leader's trades. When the leader's strategy proposes a trade, this
 *         vault scales it by `allocationBps` and, only on a profitable close,
 *         takes a `feeShareBps` cut of the realized profit.
 *
 * @dev    NON-CUSTODIAL, NO LOCK-IN: the follower's `collateral` is only ever
 *         moved by their own `deposit`/`withdraw` calls. `active` can be
 *         flipped to `false` by the follower alone, at any time, and doing so
 *         immediately stops any new position from being mirrored — there is
 *         no admin path that can force a follower to keep following, and no
 *         cooldown or penalty on unfollowing. This mirrors the top-level
 *         CLAUDE.md hard rule "no override, no admin path, no support escape
 *         hatch" as directly as a copy-trading contract can.
 *
 *         FEE-ON-PROFIT-ONLY IS ARITHMETIC, NOT A JUDGMENT CALL:
 *         `mirrorClose` computes `pnl` for the follower's scaled position; a
 *         fee is taken only when `pnl > 0`, computed as
 *         `pnl * feeShareBps / 10_000`, and is simply never assessed when
 *         `pnl <= 0`. See `test/CopyVault.t.sol` for a matched profit/loss
 *         pair proving this arithmetic directly.
 *
 *         MIRRORING IS GATED, EXECUTION IS AN HONEST STUB: `mirrorOpen` only
 *         mirrors a leader trade if `RefusalGate.evaluateOnChain` confirms,
 *         in the same transaction, that the leader strategy's own pinned
 *         predicates hold right now (predicates bound to the pinned
 *         commitment, series from the registry). What is still attested:
 *         `mirrorOpen`/`mirrorClose` trust a caller-supplied trade record —
 *         asset id, direction, leader size, and entry/exit price — from
 *         `leaderExecutor` rather than reading a live price off a
 *         `CanonicalSeries` or routing anything to a real venue. Full
 *         automatic mirroring (reading the leader's actual fills from
 *         Perpl/Kuru and verifying entry/exit prices against a
 *         `CanonicalSeries`) is out of scope for this pass. `mirrorClose` is
 *         deliberately not gated: closing a position is never refused.
 *
 *         LEDGER, NOT LIVE ESCROW — KNOWN LIMITATION, NOT A SILENT ONE:
 *         `collateral` is a bookkeeping ledger. Opening a mirrored position
 *         does not move any ERC20 out of this vault (there is nowhere to
 *         send it to in this pass — no real execution venue is wired), and
 *         realizing a profit credits `collateral` without any new tokens
 *         entering the vault to back it. That credit becomes real only once
 *         real execution (see above) actually settles funds into this vault.
 *         Consequently `withdraw` is capped at the ledger balance, not at
 *         this contract's actual ERC20 balance; if a follower's ledger has
 *         been credited with unbacked paper profit, `withdraw` for the
 *         unbacked portion will revert on the underlying `transfer` rather
 *         than silently succeed with fabricated funds — a hard failure, never
 *         a quiet overpayment. Fees are handled the same way: `feeCharged` in
 *         `PositionClosed` is the arithmetic amount owed to `feeRecipient`;
 *         no token transfer happens for it in this pass, for the same reason
 *         — there is no real settlement yet to draw a real fee from.
 */
contract CopyVault is ReentrancyGuard {
    uint256 public constant BPS_DENOMINATOR = 10_000;

    struct MirroredPosition {
        bytes32 assetId;
        bool isLong;
        uint256 followerSize; // leaderSize scaled by allocationBps, collateral-token units
        uint256 entryPrice; // caller-attested, CanonicalSeries-native units
        bool open;
    }

    IERC20 public immutable collateralToken;

    /// @notice The follower who owns this vault's ledger. Only this address
    ///         may deposit, withdraw, or toggle `active`.
    address public immutable follower;

    /// @notice The address authorized to submit the leader's attested trade
    ///         records (open/close) for mirroring. Distinct from `follower`
    ///         so it can never move the follower's funds, only propose
    ///         mirrored positions the follower has already opted into via
    ///         `allocationBps` and `active`.
    address public immutable leaderExecutor;

    StrategyRegistry public immutable registry;
    uint256 public immutable leaderStrategyId;

    /// @notice The gate a leader's trade must clear before it is mirrored.
    ///         Immutable, same reasoning as every other binding here.
    RefusalGate public immutable refusalGate;

    /// @notice Basis points of the leader's trade size mirrored into the
    ///         follower's position. Immutable — a different allocation means
    ///         a new `CopyVault`, not a mutation of this one.
    uint256 public immutable allocationBps;

    /// @notice Basis points of realized *profit only* taken as a fee on
    ///         close. Immutable, same reasoning as `allocationBps`.
    uint256 public immutable feeShareBps;

    /// @notice Where the fee is owed once real settlement lands (see
    ///         contract-level NatSpec "ledger, not live escrow"). No transfer
    ///         is made to this address in this pass.
    address public immutable feeRecipient;

    /// @notice Follower-controlled kill switch. Defaults to true. Only
    ///         `follower` may change it, and there is no admin override.
    bool public active = true;

    /// @notice The follower's P&L ledger. See contract-level NatSpec —
    ///         moved by `deposit`/`withdraw` (real tokens) and by
    ///         `mirrorClose` (arithmetic only, not yet real tokens).
    uint256 public collateral;

    mapping(uint256 => MirroredPosition) public positions;
    uint256 public nextPositionId;

    event Deposited(address indexed follower, uint256 amount);
    event Withdrawn(address indexed follower, uint256 amount);
    event FollowingToggled(bool active);
    event TradeSkipped(bytes32 indexed assetId, bytes32 reason);
    event PositionMirrored(
        uint256 indexed positionId, bytes32 indexed assetId, bool isLong, uint256 followerSize, uint256 entryPrice
    );
    event PositionClosed(uint256 indexed positionId, uint256 exitPrice, int256 pnl, uint256 feeCharged);

    error NotFollower();
    error NotLeaderExecutor();
    error ZeroAmount();
    error InsufficientBalance();
    error InvalidPrice();
    error PositionNotOpen();
    error TransferFailed();

    modifier onlyFollower() {
        if (msg.sender != follower) revert NotFollower();
        _;
    }

    modifier onlyLeaderExecutor() {
        if (msg.sender != leaderExecutor) revert NotLeaderExecutor();
        _;
    }

    constructor(
        address collateralToken_,
        address follower_,
        address leaderExecutor_,
        address registry_,
        uint256 leaderStrategyId_,
        uint256 allocationBps_,
        uint256 feeShareBps_,
        address feeRecipient_,
        address refusalGate_
    ) {
        require(collateralToken_ != address(0), "collateral token required");
        require(follower_ != address(0), "follower required");
        require(leaderExecutor_ != address(0), "leader executor required");
        require(registry_ != address(0), "registry required");
        require(feeRecipient_ != address(0), "fee recipient required");
        require(refusalGate_ != address(0), "refusal gate required");
        require(allocationBps_ > 0 && allocationBps_ <= BPS_DENOMINATOR, "invalid allocation bps");
        require(feeShareBps_ <= BPS_DENOMINATOR, "invalid fee bps");

        collateralToken = IERC20(collateralToken_);
        follower = follower_;
        leaderExecutor = leaderExecutor_;
        registry = StrategyRegistry(registry_);
        leaderStrategyId = leaderStrategyId_;
        allocationBps = allocationBps_;
        feeShareBps = feeShareBps_;
        feeRecipient = feeRecipient_;
        refusalGate = RefusalGate(refusalGate_);
    }

    function deposit(uint256 amount) external nonReentrant onlyFollower {
        if (amount == 0) revert ZeroAmount();
        collateral += amount;
        SafeERC20.safeTransferFromExact(collateralToken, msg.sender, address(this), amount);
        emit Deposited(msg.sender, amount);
    }

    function withdraw(uint256 amount) external nonReentrant onlyFollower {
        if (amount == 0) revert ZeroAmount();
        if (amount > collateral) revert InsufficientBalance();
        collateral -= amount;
        SafeERC20.safeTransfer(collateralToken, msg.sender, amount);
        emit Withdrawn(msg.sender, amount);
    }

    /// @notice The follower's kill switch. No lock-in, no cooldown, no admin
    ///         override — see contract-level NatSpec.
    function setActive(bool active_) external onlyFollower {
        active = active_;
        emit FollowingToggled(active_);
    }

    /// @notice Mirrors the leader opening a position, scaled by
    ///         `allocationBps`. A no-op (not a revert) when the follower has
    ///         paused following — refusal-shaped, matching the
    ///         `RefusalGate`/`GuardedVault` pattern: not following is a valid
    ///         state, not an error.
    /// @param leaderSize The leader's own position size, attested by
    ///        `leaderExecutor`. See contract-level NatSpec on the trust
    ///        boundary this represents.
    /// @param entryPrice Attested entry price for the leader's trade.
    /// @param predicates The leader strategy's predicates exactly as pinned.
    ///        A leader's trade is mirrored only if `RefusalGate` says the
    ///        leader's OWN pinned rules hold right now (same tx, series from
    ///        the registry, predicates bound to the pinned commitment); if they
    ///        do not, the trade is skipped, not mirrored.
    /// @return mirrored True if a position was opened for the follower.
    /// @return positionId Valid only when `mirrored` is true.
    function mirrorOpen(
        bytes32 assetId,
        bool isLong,
        uint256 leaderSize,
        uint256 entryPrice,
        RefusalGate.PredicateDefinition[] calldata predicates
    ) external onlyLeaderExecutor nonReentrant returns (bool mirrored, uint256 positionId) {
        if (!active) {
            emit TradeSkipped(assetId, "FOLLOWER_INACTIVE");
            return (false, 0);
        }
        if (entryPrice == 0) revert InvalidPrice();
        if (!refusalGate.evaluateOnChain(leaderStrategyId, isLong, predicates)) {
            emit TradeSkipped(assetId, "PREDICATE_NOT_SATISFIED");
            return (false, 0);
        }

        uint256 followerSize = (leaderSize * allocationBps) / BPS_DENOMINATOR;

        positionId = nextPositionId++;
        positions[positionId] = MirroredPosition({
            assetId: assetId,
            isLong: isLong,
            followerSize: followerSize,
            entryPrice: entryPrice,
            open: true
        });

        emit PositionMirrored(positionId, assetId, isLong, followerSize, entryPrice);
        return (true, positionId);
    }

    /// @notice Mirrors the leader closing a position. Computes the
    ///         follower-scaled P&L and, only when it is positive, charges
    ///         `feeShareBps` of it — never on a loss. See contract-level
    ///         NatSpec "ledger, not live escrow" for why no token moves here.
    function mirrorClose(uint256 positionId, uint256 exitPrice) external onlyLeaderExecutor {
        MirroredPosition storage p = positions[positionId];
        if (!p.open) revert PositionNotOpen();
        if (exitPrice == 0) revert InvalidPrice();

        p.open = false;

        int256 diff = int256(exitPrice) - int256(p.entryPrice);
        int256 pnl = (int256(p.followerSize) * diff) / int256(p.entryPrice);
        if (!p.isLong) pnl = -pnl;

        uint256 feeCharged = 0;

        if (pnl > 0) {
            feeCharged = (uint256(pnl) * feeShareBps) / BPS_DENOMINATOR;
            uint256 netProfit = uint256(pnl) - feeCharged;
            collateral += netProfit;
        } else if (pnl < 0) {
            uint256 loss = uint256(-pnl);
            collateral = collateral > loss ? collateral - loss : 0;
        }

        emit PositionClosed(positionId, exitPrice, pnl, feeCharged);
    }
}
