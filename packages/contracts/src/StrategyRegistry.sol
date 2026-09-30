// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import { PredicateEngine } from "./PredicateEngine.sol";
import { ReentrancyGuard } from "./ReentrancyGuard.sol";

/**
 * @title StrategyRegistry
 * @notice Pins a strategy on-chain with a bond, per
 *         docs/ARCHITECTURE.md's "Pinning and mutation" section, and enforces
 *         the one mutation rule that section is built around:
 *
 *           Tightening a parameter takes effect immediately. Loosening one
 *           enters a cooling-off period with a visible, unskippable countdown.
 *           There is no override, no admin key, no support path.
 *
 * @dev    BOND EXIT (two-step, no admin, no slashing). `requestRetire` starts a
 *         `loosenCooldownSeconds` countdown; the strategy stays fully active
 *         (and enforced) while it runs, so a bond cannot be pulled the moment
 *         a trade has been approved. After it, anyone may call `finalizeRetire`,
 *         which marks the strategy retired forever and refunds the bond to the
 *         owner. A retired strategy fails closed: `RefusalGate` refuses it and
 *         `MarginAccount.bindStrategy` / `VaultFactory` reject it. The owner may
 *         `cancelRetire` before finalization. A pending loosening does NOT
 *         block a retire request (retiring is the strictest outcome); once
 *         retired, `finalizeLoosening` and `proposeLoosening` revert.
 *
 *         WHAT IS PINNED. Three things, always changed together and always
 *         under the same tighten/loosen rule:
 *
 *           - `specHash`: SHA-256 over the canonical spec JSON
 *             (`packages/spec/src/hash.ts`). The chain cannot recompute it, so
 *             on its own it binds nothing the chain can check.
 *           - `predicatesCommitment`: `keccak256(abi.encode(PredicateDefinition[]))`
 *             (`packages/spec` `encodePredicates`). THIS is what the chain can
 *             check: `RefusalGate.evaluateOnChain` recomputes it from the
 *             predicates a proposer supplies and reverts unless it equals the
 *             pinned value, so a proposer cannot substitute easier predicates.
 *           - `series`: the one `CanonicalSeries` the predicates are evaluated
 *             against. It must be in this registry's immutable canonical set,
 *             so a strategy cannot be pinned to a lookalike series that
 *             always reports "satisfied". A proposer never supplies it.
 *
 *         TRUST BOUNDARY, read this before touching the contract:
 *
 *         `tighten` is NOT trusted on the caller's say-so. The caller supplies
 *         the decoded old and new predicate arrays; the contract checks that
 *         `keccak256(abi.encode(old))` equals the pinned commitment and
 *         `keccak256(abi.encode(new))` equals the new commitment, then checks a
 *         deliberately CONSERVATIVE partial order over the decoded predicates
 *         (see `tighten`). Anything the order cannot prove is a tightening must
 *         go through `proposeLoosening` and wait out the cooldown. A compromised
 *         owner key therefore cannot use `tighten` to swap in easier rules.
 *
 *         What the chain still cannot see is the off-chain `specHash` (SHA-256
 *         over spec JSON): fields that never reach a predicate (e.g. sizing)
 *         are bound only by the hash, so `tighten` only guarantees the
 *         *predicate* set is no looser. Guarantee with no exception and no
 *         admin path: once `proposeLoosening` is called, the new hash cannot
 *         become active before `cooldownEndsAt`, for anyone, including the owner.
 *
 *         No function in this contract can be called by anyone other than the
 *         strategy's own owner except `finalizeLoosening`, which is
 *         intentionally permissionless — it only ever applies a change the
 *         owner already committed to, and only after the owner's own cooldown
 *         has elapsed. There is no protocol-level admin key anywhere in this
 *         contract.
 */
contract StrategyRegistry is ReentrancyGuard {
    /// @dev MIRROR of `RefusalGate.PredicateDefinition`, field for field and in
    ///      the same order, so `abi.encode` of an array is byte-identical and
    ///      hashes to the same commitment. Mirrored (not imported) because
    ///      RefusalGate imports this contract. test/StrategyRegistry.t.sol
    ///      proves the encodings are equal; keep the two in lockstep.
    struct PredicateDefinition {
        PredicateEngine.PredicateKind kind;
        bytes32 symbol;
        PredicateEngine.Direction direction;
        uint256 swingLookbackCandles;
        uint256 minGapBps;
        PredicateEngine.ReferenceExtreme referenceExtreme;
        PredicateEngine.Lookback lookback;
        uint256 timeframeSeconds;
    }

    struct Strategy {
        address owner;
        bytes32 specHash;
        uint256 bond;
        uint256 pinnedAt;
        bytes32 pendingSpecHash;
        uint256 cooldownEndsAt;
        bytes32 predicatesCommitment;
        address series;
        bytes32 pendingPredicatesCommitment;
        address pendingSeries;
    }

    /// @notice Minimum bond required to pin a strategy. Pinned at deployment,
    ///         never changed by any function in this contract.
    uint256 public immutable minBond;

    /// @notice How long a loosening must wait before it can be finalized.
    ///         Pinned at deployment; there is no function anywhere in this
    ///         contract that can shorten, skip, or waive it.
    uint256 public immutable loosenCooldownSeconds;

    /// @notice The `CanonicalSeries` contracts a strategy may be pinned to.
    ///         Fixed at construction; there is no add function. A new series
    ///         means a new registry, the same "no setter, no admin" rule as
    ///         every other parameter here.
    mapping(address => bool) public isCanonicalSeries;
    address[] private _canonicalSeries;

    uint256 public nextStrategyId;
    mapping(uint256 => Strategy) public strategies;

    /// @notice Kept outside `Strategy` so the public `strategies` getter keeps its shape.
    /// @dev `retireEndsAt[id]` is the countdown end of a pending retire, 0 if none.
    mapping(uint256 => uint256) public retireEndsAt;
    mapping(uint256 => bool) public isRetired;

    event StrategyPinned(
        uint256 indexed strategyId,
        address indexed owner,
        bytes32 specHash,
        uint256 bond,
        bytes32 predicatesCommitment,
        address series
    );
    event Tightened(
        uint256 indexed strategyId,
        bytes32 oldSpecHash,
        bytes32 newSpecHash,
        bytes32 newPredicatesCommitment,
        address newSeries
    );
    event LooseningProposed(
        uint256 indexed strategyId,
        bytes32 pendingSpecHash,
        bytes32 pendingPredicatesCommitment,
        address pendingSeries,
        uint256 cooldownEndsAt
    );
    event LooseningFinalized(
        uint256 indexed strategyId,
        bytes32 oldSpecHash,
        bytes32 newSpecHash,
        bytes32 newPredicatesCommitment,
        address newSeries
    );

    event RetireRequested(uint256 indexed strategyId, uint256 retireEndsAt);
    event RetireCancelled(uint256 indexed strategyId);
    event StrategyRetired(uint256 indexed strategyId, address indexed owner, uint256 bondRefunded);

    error StrategyIsRetired();
    error RetireAlreadyRequested();
    error NoPendingRetire();
    error RefundFailed();
    error NotOwner();
    error BondTooLow();
    error NoPendingLoosening();
    error CoolingOff(uint256 cooldownEndsAt);
    error UnknownStrategy();
    error EmptySpecHash();
    error EmptyCommitment();
    error SeriesNotCanonical(address series);
    error OldPredicatesMismatch();
    error NewPredicatesMismatch();
    error SeriesChangeIsLoosening();
    /// @notice The change is not provably a tightening; use `proposeLoosening`.
    ///         `index` is the first offending predicate (or the old length if
    ///         predicates were removed).
    error NotATightening(uint256 index);

    constructor(uint256 minBond_, uint256 loosenCooldownSeconds_, address[] memory canonicalSeries_) {
        require(loosenCooldownSeconds_ > 0, "cooldown required");
        require(canonicalSeries_.length > 0, "series required");
        minBond = minBond_;
        loosenCooldownSeconds = loosenCooldownSeconds_;
        for (uint256 i = 0; i < canonicalSeries_.length; i++) {
            address s = canonicalSeries_[i];
            require(s != address(0), "series required");
            if (!isCanonicalSeries[s]) {
                isCanonicalSeries[s] = true;
                _canonicalSeries.push(s);
            }
        }
    }

    modifier onlyOwner(uint256 strategyId) {
        if (strategies[strategyId].owner != msg.sender) revert NotOwner();
        _;
    }

    modifier exists(uint256 strategyId) {
        if (strategies[strategyId].owner == address(0)) revert UnknownStrategy();
        _;
    }

    /// @dev Every spec change (pin, tighten, loosening) is validated the same
    ///      way: a non-empty spec hash and predicates commitment, and a series
    ///      from the immutable canonical set.
    function _validate(bytes32 specHash, bytes32 predicatesCommitment, address series) internal view {
        if (specHash == bytes32(0)) revert EmptySpecHash();
        if (predicatesCommitment == bytes32(0)) revert EmptyCommitment();
        if (!isCanonicalSeries[series]) revert SeriesNotCanonical(series);
    }

    /// @notice Pins a brand-new strategy. The bond is held by this contract
    ///         until the strategy is retired (`requestRetire` / `finalizeRetire`).
    /// @param specHash SHA-256 of the canonical spec JSON.
    /// @param predicatesCommitment `keccak256(abi.encode(PredicateDefinition[]))`.
    /// @param series The canonical series the predicates are evaluated against.
    function pinStrategy(bytes32 specHash, bytes32 predicatesCommitment, address series)
        external
        payable
        returns (uint256 strategyId)
    {
        if (msg.value < minBond) revert BondTooLow();
        _validate(specHash, predicatesCommitment, series);

        strategyId = nextStrategyId++;
        strategies[strategyId] = Strategy({
            owner: msg.sender,
            specHash: specHash,
            bond: msg.value,
            pinnedAt: block.timestamp,
            pendingSpecHash: bytes32(0),
            cooldownEndsAt: 0,
            predicatesCommitment: predicatesCommitment,
            series: series,
            pendingPredicatesCommitment: bytes32(0),
            pendingSeries: address(0)
        });

        emit StrategyPinned(strategyId, msg.sender, specHash, msg.value, predicatesCommitment, series);
    }

    /// @notice Applies a tightened spec immediately, but only if the decoded
    ///         predicates PROVE it is a tightening. Also cancels any in-flight
    ///         loosening proposal, since a tighten supersedes it.
    /// @dev    The rule is a conservative partial order. `newPredicates` is
    ///         accepted iff:
    ///           - `keccak256(abi.encode(oldPredicates))` is the pinned commitment
    ///             and `keccak256(abi.encode(newPredicates))` is
    ///             `newPredicatesCommitment`;
    ///           - `newSeries` equals the pinned series (a different series is
    ///             a different market; never provably stricter);
    ///           - `newPredicates.length >= oldPredicates.length`;
    ///           - for every index i < old.length every field is identical
    ///             (kind, symbol, direction, swingLookbackCandles,
    ///             referenceExtreme, lookback, timeframeSeconds) except
    ///             `minGapBps`, which may stay equal or INCREASE;
    ///           - predicates appended after the old ones are allowed (the
    ///             rule is a conjunction, so extra terms only refuse more).
    ///         Everything else (removal, reorder, lower minGapBps, changed
    ///         lookback or timeframe) reverts `NotATightening`. Knobs such as
    ///         lookbacks are ambiguous: a longer window can widen or narrow
    ///         what passes depending on the kind and direction, and proving
    ///         direction per kind on-chain is unnecessary risk. They are
    ///         therefore treated as loosening and wait out the cooldown. Being
    ///         conservative here only ever costs the owner a wait, never
    ///         weakens the rule. No admin path exists.
    function tighten(
        uint256 strategyId,
        bytes32 newSpecHash,
        bytes32 newPredicatesCommitment,
        address newSeries,
        PredicateDefinition[] calldata oldPredicates,
        PredicateDefinition[] calldata newPredicates
    ) external onlyOwner(strategyId) {
        _validate(newSpecHash, newPredicatesCommitment, newSeries);
        if (isRetired[strategyId]) revert StrategyIsRetired();
        Strategy storage s = strategies[strategyId];
        if (keccak256(abi.encode(oldPredicates)) != s.predicatesCommitment) revert OldPredicatesMismatch();
        if (keccak256(abi.encode(newPredicates)) != newPredicatesCommitment) revert NewPredicatesMismatch();
        if (newSeries != s.series) revert SeriesChangeIsLoosening();
        _requireTightening(oldPredicates, newPredicates);

        bytes32 old = s.specHash;
        s.specHash = newSpecHash;
        s.predicatesCommitment = newPredicatesCommitment;
        s.series = newSeries;

        if (s.pendingSpecHash != bytes32(0)) {
            s.pendingSpecHash = bytes32(0);
            s.pendingPredicatesCommitment = bytes32(0);
            s.pendingSeries = address(0);
            s.cooldownEndsAt = 0;
        }

        emit Tightened(strategyId, old, newSpecHash, newPredicatesCommitment, newSeries);
    }

    function _requireTightening(PredicateDefinition[] calldata o, PredicateDefinition[] calldata n) internal pure {
        if (n.length < o.length) revert NotATightening(o.length);
        for (uint256 i = 0; i < o.length; i++) {
            PredicateDefinition calldata a = o[i];
            PredicateDefinition calldata b = n[i];
            if (
                a.kind != b.kind || a.symbol != b.symbol || a.direction != b.direction
                    || a.swingLookbackCandles != b.swingLookbackCandles || a.referenceExtreme != b.referenceExtreme
                    || a.lookback != b.lookback || a.timeframeSeconds != b.timeframeSeconds
                    || b.minGapBps < a.minGapBps
            ) revert NotATightening(i);
        }
    }

    /// @notice Starts the cooling-off period for a loosened spec. Does not touch
    ///         the active spec hash, commitment or series — that only happens
    ///         in `finalizeLoosening`, and only after the timer has fully
    ///         elapsed. A new commitment or a new series is a spec change like
    ///         any other and waits out the same countdown.
    function proposeLoosening(
        uint256 strategyId,
        bytes32 newSpecHash,
        bytes32 newPredicatesCommitment,
        address newSeries
    ) external onlyOwner(strategyId) {
        _validate(newSpecHash, newPredicatesCommitment, newSeries);
        if (isRetired[strategyId]) revert StrategyIsRetired();
        Strategy storage s = strategies[strategyId];
        s.pendingSpecHash = newSpecHash;
        s.pendingPredicatesCommitment = newPredicatesCommitment;
        s.pendingSeries = newSeries;
        s.cooldownEndsAt = block.timestamp + loosenCooldownSeconds;

        emit LooseningProposed(strategyId, newSpecHash, newPredicatesCommitment, newSeries, s.cooldownEndsAt);
    }

    /// @notice Permissionless on purpose: it only ever applies a change the
    ///         owner already committed to via `proposeLoosening`, and only once
    ///         `cooldownEndsAt` has passed. There is no path, for the owner or
    ///         anyone else, to make this succeed earlier.
    function finalizeLoosening(uint256 strategyId) external exists(strategyId) {
        if (isRetired[strategyId]) revert StrategyIsRetired();
        Strategy storage s = strategies[strategyId];
        if (s.pendingSpecHash == bytes32(0)) revert NoPendingLoosening();
        if (block.timestamp < s.cooldownEndsAt) revert CoolingOff(s.cooldownEndsAt);

        bytes32 old = s.specHash;
        s.specHash = s.pendingSpecHash;
        s.predicatesCommitment = s.pendingPredicatesCommitment;
        s.series = s.pendingSeries;
        s.pendingSpecHash = bytes32(0);
        s.pendingPredicatesCommitment = bytes32(0);
        s.pendingSeries = address(0);
        s.cooldownEndsAt = 0;

        emit LooseningFinalized(strategyId, old, s.specHash, s.predicatesCommitment, s.series);
    }

    /// @notice Starts the retire countdown (`loosenCooldownSeconds`). The
    ///         strategy stays active and enforced until `finalizeRetire`.
    function requestRetire(uint256 strategyId) external onlyOwner(strategyId) {
        if (isRetired[strategyId]) revert StrategyIsRetired();
        if (retireEndsAt[strategyId] != 0) revert RetireAlreadyRequested();
        uint256 endsAt = block.timestamp + loosenCooldownSeconds;
        retireEndsAt[strategyId] = endsAt;
        emit RetireRequested(strategyId, endsAt);
    }

    /// @notice Owner withdraws a pending retire request; the strategy carries on.
    function cancelRetire(uint256 strategyId) external onlyOwner(strategyId) {
        if (retireEndsAt[strategyId] == 0) revert NoPendingRetire();
        retireEndsAt[strategyId] = 0;
        emit RetireCancelled(strategyId);
    }

    /// @notice Permissionless once the countdown has elapsed. Marks the
    ///         strategy retired (terminal) and refunds the whole bond to its
    ///         owner. Cannot run earlier for anyone; there is no admin path
    ///         and no slashing.
    function finalizeRetire(uint256 strategyId) external nonReentrant exists(strategyId) {
        if (isRetired[strategyId]) revert StrategyIsRetired();
        uint256 endsAt = retireEndsAt[strategyId];
        if (endsAt == 0) revert NoPendingRetire();
        if (block.timestamp < endsAt) revert CoolingOff(endsAt);

        Strategy storage s = strategies[strategyId];
        address owner_ = s.owner;
        uint256 bond = s.bond;

        isRetired[strategyId] = true;
        retireEndsAt[strategyId] = 0;
        s.bond = 0;
        s.pendingSpecHash = bytes32(0);
        s.pendingPredicatesCommitment = bytes32(0);
        s.pendingSeries = address(0);
        s.cooldownEndsAt = 0;

        (bool ok,) = owner_.call{ value: bond }("");
        if (!ok) revert RefundFailed();

        emit StrategyRetired(strategyId, owner_, bond);
    }

    function activeSpecHash(uint256 strategyId) external view returns (bytes32) {
        return strategies[strategyId].specHash;
    }

    /// @notice The currently active predicates commitment. Zero for an unknown
    ///         strategy (a real commitment is never zero).
    function activePredicatesCommitment(uint256 strategyId) external view returns (bytes32) {
        return strategies[strategyId].predicatesCommitment;
    }

    /// @notice The canonical series the strategy's predicates are evaluated
    ///         against. `address(0)` for an unknown strategy.
    function activeSeries(uint256 strategyId) external view returns (address) {
        return strategies[strategyId].series;
    }

    function ownerOf(uint256 strategyId) external view returns (address) {
        return strategies[strategyId].owner;
    }

    function canonicalSeries() external view returns (address[] memory) {
        return _canonicalSeries;
    }
}
