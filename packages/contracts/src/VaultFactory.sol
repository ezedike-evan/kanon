// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import { GuardedVault } from "./GuardedVault.sol";
import { CopyVault } from "./CopyVault.sol";
import { StrategyRegistry } from "./StrategyRegistry.sol";

/**
 * @title VaultFactory
 * @notice Creates a `GuardedVault` or a `CopyVault` for the caller, wires it
 *         to this deployment's canonical infrastructure, and records it so
 *         anyone can verify that a vault at some address was made here.
 *
 * @dev    WHAT THE FACTORY FIXES, AND WHY THE USER CANNOT CHOOSE IT. The
 *         collateral token, `StrategyRegistry` and `RefusalGate` are
 *         immutable factory configuration. The series a vault is evaluated
 *         against is not a vault parameter at all: it is the series in the
 *         strategy's pinned spec, and the registry only accepts series from
 *         its own immutable canonical set. A vault therefore cannot be
 *         pointed at a lookalike gate or a series that always reports
 *         "satisfied": if `isVault(x)` is true, `x` enforces the rules of the
 *         deployment this factory belongs to.
 *
 *         THE CALLER IS THE OWNER. `createGuardedVault` makes `msg.sender` the
 *         vault's owner and `createCopyVault` makes `msg.sender` the follower.
 *         Nobody can create a vault that names someone else as owner, so a
 *         vault listed under an address was created by that address (or by
 *         that address's own contract). For a `GuardedVault` the caller must
 *         also be the owner of the pinned strategy the vault is bound to —
 *         the product enforces *your own* rules against you, not someone
 *         else's. Everything else (whitelist, drawdown cap, executor,
 *         allocation, fee) is passed through to the vault's constructor, which
 *         validates it and makes it immutable.
 *
 *         LOOSENING A VAULT WAITS OUT THE COOLING-OFF. A `GuardedVault`'s
 *         limits (asset whitelist, daily drawdown cap) are immutable, so
 *         "loosening" one can only mean creating a NEW vault with looser
 *         limits and moving funds into it — which would sidestep the
 *         tighten-immediately / loosen-after-cooling-off rule if anyone could
 *         call this factory directly. So the factory keeps, per (owner,
 *         strategy), the limits of the owner's latest vault (its "posture"):
 *
 *           - the first vault for a strategy, or any vault whose limits are
 *             tighter-or-equal to the posture (drawdown cap `<=` AND every
 *             asset already in the posture's whitelist), is created
 *             immediately and becomes the new posture;
 *           - a LOOSER vault (higher cap, or any asset outside the posture's
 *             whitelist) needs a matching `requestLooserVault(...)` made at
 *             least `registry.loosenCooldownSeconds()` earlier
 *             (`NoLoosenRequest` / `LoosenHold` otherwise). The request is
 *             consumed by the creation and there is no way to skip or shorten
 *             the wait, for the owner or anyone else.
 *
 *         Because the posture always becomes the newest vault's limits, creating
 *         a tight vault and then a looser one straight after does not bypass
 *         the hold. Scope, stated plainly: this governs vaults the factory
 *         recognizes (`isVault`). A `GuardedVault` deployed by hand is not
 *         recognized by the factory, the indexer or the app, and per-address
 *         Sybil (a different owner address, or a newly pinned strategy) is not
 *         something a contract can prevent. `CopyVault`'s allocation/fee are
 *         not covered by this hold.
 *
 *         The factory holds no funds, has no owner and no privileged function.
 *         It never calls a model and does no arithmetic beyond bookkeeping.
 */
contract VaultFactory {
    enum VaultKind {
        None,
        Guarded,
        Copy
    }

    address public immutable collateralToken;
    StrategyRegistry public immutable registry;
    address public immutable refusalGate;

    /// @notice vault address -> what it is. `VaultKind.None` for anything the
    ///         factory did not create.
    mapping(address => VaultKind) public vaultKindOf;

    /// @dev Posture per (owner, strategy): epoch 0 = none yet; else the epoch of
    ///      the latest vault, its drawdown cap, and (keyed by epoch) its whitelist.
    mapping(address => mapping(uint256 => uint256)) private _postureEpoch;
    mapping(address => mapping(uint256 => uint256)) private _postureMaxDrawdownBps;
    mapping(bytes32 => bool) private _postureAsset;

    /// @notice requestId => timestamp of the `requestLooserVault` call, 0 if none.
    mapping(bytes32 => uint256) public loosenRequestedAt;

    address[] private _guardedVaults;
    address[] private _copyVaults;
    mapping(address => address[]) private _guardedVaultsOf;
    mapping(address => address[]) private _copyVaultsOf;

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

    event LooserVaultRequested(
        address indexed owner, uint256 indexed strategyId, bytes32 indexed requestId, uint256 availableAt
    );

    error UnknownStrategy();
    error NotStrategyOwner();
    error NoLoosenRequest();
    error LoosenHold(uint256 availableAt);

    constructor(address collateralToken_, address registry_, address refusalGate_) {
        require(collateralToken_ != address(0), "collateral token required");
        require(registry_ != address(0), "registry required");
        require(refusalGate_ != address(0), "refusal gate required");

        collateralToken = collateralToken_;
        registry = StrategyRegistry(registry_);
        refusalGate = refusalGate_;
    }

    /// @notice Creates a `GuardedVault` owned by the caller, bound to the
    ///         caller's own pinned strategy `strategyId`.
    /// @param strategyExecutor Address allowed to propose trades for the owner
    ///        (typically an agent key). Cannot withdraw.
    /// @param strategyId The caller's pinned strategy.
    /// @param whitelistedAssetIds Immutable asset whitelist for the vault.
    /// @param maxDailyDrawdownBps Immutable daily drawdown cap, in bps.
    function createGuardedVault(
        address strategyExecutor,
        uint256 strategyId,
        bytes32[] calldata whitelistedAssetIds,
        uint256 maxDailyDrawdownBps
    ) external returns (address vault) {
        address strategyOwner = registry.ownerOf(strategyId);
        if (strategyOwner == address(0)) revert UnknownStrategy();
        if (strategyOwner != msg.sender) revert NotStrategyOwner();

        _enforceLoosenHold(strategyId, whitelistedAssetIds, maxDailyDrawdownBps);

        vault = address(
            new GuardedVault(
                collateralToken,
                msg.sender,
                strategyExecutor,
                address(registry),
                strategyId,
                whitelistedAssetIds,
                maxDailyDrawdownBps,
                refusalGate
            )
        );

        _setPosture(msg.sender, strategyId, whitelistedAssetIds, maxDailyDrawdownBps);

        vaultKindOf[vault] = VaultKind.Guarded;
        _guardedVaults.push(vault);
        _guardedVaultsOf[msg.sender].push(vault);

        // `series` is informational: the strategy's pinned series at creation.
        emit GuardedVaultCreated(
            vault,
            msg.sender,
            strategyId,
            strategyExecutor,
            registry.activeSeries(strategyId),
            maxDailyDrawdownBps,
            whitelistedAssetIds
        );
    }

    /// @notice Starts the cooling-off clock for a vault that is LOOSER than the
    ///         caller's current posture for `strategyId`. After
    ///         `registry.loosenCooldownSeconds()` the caller may create exactly
    ///         this vault (same strategy, same whitelist in the same order,
    ///         same cap). Requesting again does not restart the clock.
    function requestLooserVault(
        uint256 strategyId,
        bytes32[] calldata whitelistedAssetIds,
        uint256 maxDailyDrawdownBps
    ) external returns (bytes32 requestId, uint256 availableAt) {
        if (registry.ownerOf(strategyId) != msg.sender) revert NotStrategyOwner();
        requestId = _requestId(msg.sender, strategyId, whitelistedAssetIds, maxDailyDrawdownBps);
        if (loosenRequestedAt[requestId] == 0) loosenRequestedAt[requestId] = block.timestamp;
        availableAt = loosenRequestedAt[requestId] + registry.loosenCooldownSeconds();
        emit LooserVaultRequested(msg.sender, strategyId, requestId, availableAt);
    }

    /// @notice True iff a vault with these limits would be LOOSER than
    ///         `owner`'s current posture for `strategyId`: a higher drawdown
    ///         cap, or any asset not in the posture's whitelist. False when the
    ///         owner has no vault for the strategy yet (nothing to loosen).
    function isLooserThanPosture(
        address owner,
        uint256 strategyId,
        bytes32[] calldata whitelistedAssetIds,
        uint256 maxDailyDrawdownBps
    ) public view returns (bool) {
        uint256 epoch = _postureEpoch[owner][strategyId];
        if (epoch == 0) return false;
        if (maxDailyDrawdownBps > _postureMaxDrawdownBps[owner][strategyId]) return true;
        for (uint256 i = 0; i < whitelistedAssetIds.length; i++) {
            if (!_postureAsset[_assetKey(owner, strategyId, epoch, whitelistedAssetIds[i])]) return true;
        }
        return false;
    }

    /// @notice The limits of `owner`'s latest vault for `strategyId`.
    function postureOf(address owner, uint256 strategyId) external view returns (bool set, uint256 maxDrawdownBps) {
        return (_postureEpoch[owner][strategyId] != 0, _postureMaxDrawdownBps[owner][strategyId]);
    }

    function postureAllowsAsset(address owner, uint256 strategyId, bytes32 assetId) external view returns (bool) {
        uint256 epoch = _postureEpoch[owner][strategyId];
        return epoch != 0 && _postureAsset[_assetKey(owner, strategyId, epoch, assetId)];
    }

    function looserVaultRequestId(
        address owner,
        uint256 strategyId,
        bytes32[] calldata whitelistedAssetIds,
        uint256 maxDailyDrawdownBps
    ) external pure returns (bytes32) {
        return _requestId(owner, strategyId, whitelistedAssetIds, maxDailyDrawdownBps);
    }

    function _enforceLoosenHold(uint256 strategyId, bytes32[] calldata whitelistedAssetIds, uint256 maxDailyDrawdownBps)
        internal
    {
        if (!isLooserThanPosture(msg.sender, strategyId, whitelistedAssetIds, maxDailyDrawdownBps)) return;

        bytes32 requestId = _requestId(msg.sender, strategyId, whitelistedAssetIds, maxDailyDrawdownBps);
        uint256 requestedAt = loosenRequestedAt[requestId];
        if (requestedAt == 0) revert NoLoosenRequest();
        uint256 availableAt = requestedAt + registry.loosenCooldownSeconds();
        if (block.timestamp < availableAt) revert LoosenHold(availableAt);
        delete loosenRequestedAt[requestId];
    }

    function _setPosture(
        address owner,
        uint256 strategyId,
        bytes32[] calldata whitelistedAssetIds,
        uint256 maxDailyDrawdownBps
    ) internal {
        uint256 epoch = ++_postureEpoch[owner][strategyId];
        _postureMaxDrawdownBps[owner][strategyId] = maxDailyDrawdownBps;
        for (uint256 i = 0; i < whitelistedAssetIds.length; i++) {
            _postureAsset[_assetKey(owner, strategyId, epoch, whitelistedAssetIds[i])] = true;
        }
    }

    function _assetKey(address owner, uint256 strategyId, uint256 epoch, bytes32 assetId)
        private
        pure
        returns (bytes32)
    {
        return keccak256(abi.encode(owner, strategyId, epoch, assetId));
    }

    function _requestId(
        address owner,
        uint256 strategyId,
        bytes32[] calldata whitelistedAssetIds,
        uint256 maxDailyDrawdownBps
    ) private pure returns (bytes32) {
        return keccak256(abi.encode(owner, strategyId, maxDailyDrawdownBps, whitelistedAssetIds));
    }

    /// @notice Creates a `CopyVault` with the caller as follower, following
    ///         the leader's pinned strategy `leaderStrategyId`.
    function createCopyVault(
        address leaderExecutor,
        uint256 leaderStrategyId,
        uint256 allocationBps,
        uint256 feeShareBps,
        address feeRecipient
    ) external returns (address vault) {
        if (registry.ownerOf(leaderStrategyId) == address(0)) revert UnknownStrategy();

        vault = address(
            new CopyVault(
                collateralToken,
                msg.sender,
                leaderExecutor,
                address(registry),
                leaderStrategyId,
                allocationBps,
                feeShareBps,
                feeRecipient,
                refusalGate
            )
        );

        vaultKindOf[vault] = VaultKind.Copy;
        _copyVaults.push(vault);
        _copyVaultsOf[msg.sender].push(vault);

        emit CopyVaultCreated(
            vault, msg.sender, leaderStrategyId, leaderExecutor, allocationBps, feeShareBps, feeRecipient
        );
    }

    /// @notice True iff `vault` was created by this factory (of either kind).
    function isVault(address vault) external view returns (bool) {
        return vaultKindOf[vault] != VaultKind.None;
    }

    function isGuardedVault(address vault) external view returns (bool) {
        return vaultKindOf[vault] == VaultKind.Guarded;
    }

    function isCopyVault(address vault) external view returns (bool) {
        return vaultKindOf[vault] == VaultKind.Copy;
    }

    function guardedVaultCount() external view returns (uint256) {
        return _guardedVaults.length;
    }

    function copyVaultCount() external view returns (uint256) {
        return _copyVaults.length;
    }

    function guardedVaultAt(uint256 index) external view returns (address) {
        return _guardedVaults[index];
    }

    function copyVaultAt(uint256 index) external view returns (address) {
        return _copyVaults[index];
    }

    function guardedVaultsOf(address owner) external view returns (address[] memory) {
        return _guardedVaultsOf[owner];
    }

    function copyVaultsOf(address follower) external view returns (address[] memory) {
        return _copyVaultsOf[follower];
    }
}
