// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

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
 * @dev    WHAT IS PINNED. Three things, always changed together and always
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
 *         Whether a new spec is a "tightening" or a "loosening" of the pinned
 *         one is a semantic comparison over the strategy spec's parameters
 *         (e.g. "is a wider stop distance looser?"). That comparison lives
 *         off-chain, in `packages/spec` and the spec-review UI, where the full
 *         typed spec is available. This contract only ever sees opaque
 *         `bytes32` hashes (the spec hash and the predicates commitment) — it has
 *         no spec to compare, so it cannot verify the caller's claim. In
 *         particular a `tighten` that swaps in a different commitment (easier
 *         predicates) applies immediately, exactly like any other `tighten`.
 *
 *         Instead, the caller *asserts* which kind of change this is by which
 *         function they call: `tighten` applies immediately, no questions
 *         asked; `proposeLoosening` + `finalizeLoosening` always pays the full
 *         cooldown. A malicious or buggy caller (i.e. a compromised owner key)
 *         could call `tighten` with a spec that is actually looser. That is a
 *         real gap in this pass — closing it requires either (a) an on-chain
 *         partial-order check over decoded spec parameters instead of opaque
 *         hashes, or (b) a signed attestation from the spec-review UI that
 *         itself proves the direction of change. Both are follow-up work, not
 *         silently assumed away. What this contract *does* guarantee, with no
 *         exception and no admin path: once `proposeLoosening` is called, the
 *         new hash cannot become active before `cooldownEndsAt`, for anyone,
 *         including the owner.
 *
 *         No function in this contract can be called by anyone other than the
 *         strategy's own owner except `finalizeLoosening`, which is
 *         intentionally permissionless — it only ever applies a change the
 *         owner already committed to, and only after the owner's own cooldown
 *         has elapsed. There is no protocol-level admin key anywhere in this
 *         contract.
 */
contract StrategyRegistry {
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

    error NotOwner();
    error BondTooLow();
    error NoPendingLoosening();
    error CoolingOff(uint256 cooldownEndsAt);
    error UnknownStrategy();
    error EmptySpecHash();
    error EmptyCommitment();
    error SeriesNotCanonical(address series);

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

    /// @notice Pins a brand-new strategy. The bond is held by this contract for
    ///         the lifetime of the strategy; withdrawing it is out of scope for
    ///         this pass (see README follow-ups).
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

    /// @notice Applies a tightened spec immediately. See the contract-level
    ///         NatSpec: the caller is asserting this is a tightening by calling
    ///         this function rather than `proposeLoosening`. Also cancels any
    ///         in-flight loosening proposal, since a tighten supersedes it.
    function tighten(uint256 strategyId, bytes32 newSpecHash, bytes32 newPredicatesCommitment, address newSeries)
        external
        onlyOwner(strategyId)
    {
        _validate(newSpecHash, newPredicatesCommitment, newSeries);
        Strategy storage s = strategies[strategyId];
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
