// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {WOTS} from "./WOTS.sol";

/// @title OptimisticAggregator
/// @notice An aggregator posts a Merkle root over many (pkHash, m, keccak256(sig)) leaves with a bond.
///         Anyone can challenge a leaf during the window by revealing its signature; if the WOTS
///         signature is invalid the batch is slashed. A slash pays half the bond to the challenger and burns
///         the rest, so an aggregator that challenges its own bad batch still loses half (SR-R2).
///
///         Data availability (SR-R1): the chain only sees keccak256(sig), so a leaf whose signature is withheld
///         could not be challenged. During the window anyone can pay `revealDeposit` to `requestReveal(id, index)`.
///         The signature must then be posted with `reveal` within `revealWindow` (by the aggregator, or anyone
///         holding it). A valid reveal refunds the deposit; an invalid one slashes at once; no reveal by the
///         deadline lets anyone `slashUnrevealed`. The requester gets half the bond plus the deposit back.
///         `finalize` reverts while any request on the batch is open, and not before `finalizeAt(id)` (the
///         later of the window end and the last request's reveal deadline), so a request made at the very end
///         of the window can still be answered.
///         Payouts to requesters/challengers that reject ETH (or burn gas) are credited for `withdraw` instead
///         of reverting, so a hostile requester cannot block a reveal and lock an honest batch.
contract OptimisticAggregator {
    error WrongBond();
    error UnknownBatch();
    error WindowClosed();
    error WindowOpen();
    error AlreadySlashed();
    error AlreadyFinalized();
    error NotInBatch();
    error SignatureValid();
    error TransferFailed();
    error BadWindow();
    error WrongDeposit();
    error AlreadyRequested();
    error NoRevealRequest();
    error RevealExpired();
    error RevealWindowOpen();
    error RevealPending();
    error NotSlashed();

    event BatchSubmitted(uint256 indexed id, address indexed aggregator, bytes32 root, uint32 count, string dataURI);
    event BatchSlashed(uint256 indexed id, address indexed challenger, uint256 index);
    event BatchFinalized(uint256 indexed id);
    event RevealRequested(uint256 indexed id, uint256 indexed index, address indexed requester, uint64 deadline);
    /// @notice The signature of leaf `index`, now on chain. `valid = false` means the batch was slashed.
    event Revealed(uint256 indexed id, uint256 indexed index, bytes32 pkHash, bytes32 m, bytes sig, bool valid);
    event RevealMissed(uint256 indexed id, uint256 indexed index);
    event DepositReturned(uint256 indexed id, uint256 indexed index, address indexed requester);
    event PaymentDeferred(address indexed to, uint256 amount);
    event Withdrawn(address indexed to, uint256 amount);

    struct Batch {
        bytes32 root;
        address aggregator;
        uint64 deadline;
        uint32 count;
        bool slashed;
        bool finalized;
    }

    struct RevealRequest {
        address requester;
        uint64 deadline;
        bool open;
    }

    /// @notice Where the burned half of a slashed bond goes.
    address public constant BURN = 0x000000000000000000000000000000000000dEaD;
    /// @dev Gas for a payout call; on failure the amount is credited instead (no revert, no gas griefing).
    uint256 internal constant PAYOUT_GAS = 50_000;

    uint256 public immutable bond;
    uint256 public immutable window;
    uint256 public immutable revealDeposit;
    uint256 public immutable revealWindow;
    uint256 public batchCount;
    mapping(uint256 => Batch) public batches;
    /// @notice reveals[id][index]: the (single) reveal request ever made for that leaf.
    mapping(uint256 => mapping(uint256 => RevealRequest)) public reveals;
    /// @notice Number of unanswered reveal requests on a batch.
    mapping(uint256 => uint256) public openReveals;
    /// @notice Latest reveal deadline of any request on a batch (0 if none).
    mapping(uint256 => uint64) public lastRevealDeadline;
    /// @notice Payouts that could not be pushed, claimable with withdraw().
    mapping(address => uint256) public credits;
    uint256 public totalCredits;

    constructor(uint256 bond_, uint256 window_, uint256 revealDeposit_, uint256 revealWindow_) {
        // deadlines are stored as uint64(block.timestamp + window): keep the sums far from truncating
        if (window_ > type(uint64).max / 2) revert BadWindow();
        if (revealWindow_ == 0 || revealWindow_ > type(uint64).max / 2) revert BadWindow();
        bond = bond_;
        window = window_;
        revealDeposit = revealDeposit_;
        revealWindow = revealWindow_;
    }

    function submitBatch(bytes32 root, uint32 count, string calldata dataURI) external payable returns (uint256 id) {
        if (msg.value != bond) revert WrongBond();
        id = batchCount++;
        batches[id] = Batch({
            root: root,
            aggregator: msg.sender,
            deadline: uint64(block.timestamp + window),
            count: count,
            slashed: false,
            finalized: false
        });
        emit BatchSubmitted(id, msg.sender, root, count, dataURI);
    }

    function challenge(
        uint256 id,
        bytes32 pkHash,
        bytes32 m,
        bytes calldata sig,
        uint256 index,
        bytes32[] calldata proof
    ) external {
        Batch storage b = batches[id];
        if (b.aggregator == address(0)) revert UnknownBatch();
        if (b.slashed) revert AlreadySlashed();
        if (block.timestamp >= b.deadline) revert WindowClosed();
        bytes32 leaf = leafOf(pkHash, m, sig);
        if (!_inBatch(b, leaf, index, proof)) revert NotInBatch();
        if (WOTS.verify(pkHash, m, sig)) revert SignatureValid();

        _slash(id, b, msg.sender, index, 0);
    }

    // ---- data-availability challenge (SR-R1) ----

    /// @notice Demand that leaf `index`'s signature be posted on chain within revealWindow. Pay revealDeposit.
    function requestReveal(uint256 id, uint256 index) external payable {
        Batch storage b = batches[id];
        if (b.aggregator == address(0)) revert UnknownBatch();
        if (b.slashed) revert AlreadySlashed();
        if (block.timestamp >= b.deadline) revert WindowClosed();
        if (index >= b.count) revert NotInBatch();
        if (msg.value != revealDeposit) revert WrongDeposit();
        RevealRequest storage r = reveals[id][index];
        if (r.requester != address(0)) revert AlreadyRequested();
        uint64 dl = uint64(block.timestamp + revealWindow);
        reveals[id][index] = RevealRequest({requester: msg.sender, deadline: dl, open: true});
        openReveals[id] += 1;
        if (dl > lastRevealDeadline[id]) lastRevealDeadline[id] = dl;
        emit RevealRequested(id, index, msg.sender, dl);
    }

    /// @notice Answer an open reveal request with the committed signature. Anyone holding the data may call.
    ///         A valid signature refunds the requester's deposit; an invalid one slashes the batch at once.
    function reveal(uint256 id, uint256 index, bytes32 pkHash, bytes32 m, bytes calldata sig, bytes32[] calldata proof)
        external
    {
        RevealRequest storage r = reveals[id][index];
        if (!r.open) revert NoRevealRequest();
        Batch storage b = batches[id];
        if (b.slashed) revert AlreadySlashed();
        if (block.timestamp >= r.deadline) revert RevealExpired();
        if (!_inBatch(b, leafOf(pkHash, m, sig), index, proof)) revert NotInBatch();

        r.open = false;
        openReveals[id] -= 1;
        bool valid = WOTS.verify(pkHash, m, sig);
        emit Revealed(id, index, pkHash, m, sig, valid);
        if (valid) {
            _pay(r.requester, revealDeposit);
        } else {
            _slash(id, b, r.requester, index, revealDeposit);
        }
    }

    /// @notice Slash a batch whose reveal request passed its deadline unanswered. Anyone may call; the payout
    ///         (half the bond plus the deposit) goes to the requester.
    function slashUnrevealed(uint256 id, uint256 index) external {
        RevealRequest storage r = reveals[id][index];
        if (!r.open) revert NoRevealRequest();
        Batch storage b = batches[id];
        if (b.slashed) revert AlreadySlashed();
        if (block.timestamp < r.deadline) revert RevealWindowOpen();

        r.open = false;
        openReveals[id] -= 1;
        emit RevealMissed(id, index);
        _slash(id, b, r.requester, index, revealDeposit);
    }

    /// @notice Return the deposit of a request left open on a batch that was slashed through another leaf.
    function reclaimDeposit(uint256 id, uint256 index) external {
        RevealRequest storage r = reveals[id][index];
        if (!r.open) revert NoRevealRequest();
        if (!batches[id].slashed) revert NotSlashed();
        r.open = false;
        openReveals[id] -= 1;
        emit DepositReturned(id, index, r.requester);
        _pay(r.requester, revealDeposit);
    }

    /// @notice Claim payouts that could not be pushed.
    function withdraw() external {
        uint256 amount = credits[msg.sender];
        credits[msg.sender] = 0;
        totalCredits -= amount;
        emit Withdrawn(msg.sender, amount);
        (bool sent,) = msg.sender.call{value: amount}("");
        if (!sent) revert TransferFailed();
    }

    /// @notice Earliest time finalize can succeed (also needs no open reveal request).
    function finalizeAt(uint256 id) public view returns (uint256) {
        uint256 d = batches[id].deadline;
        uint256 r = lastRevealDeadline[id];
        return r > d ? r : d;
    }

    function finalize(uint256 id) external {
        Batch storage b = batches[id];
        if (b.aggregator == address(0)) revert UnknownBatch();
        if (b.slashed) revert AlreadySlashed();
        if (b.finalized) revert AlreadyFinalized();
        if (openReveals[id] != 0) revert RevealPending();
        if (block.timestamp < finalizeAt(id)) revert WindowOpen();

        b.finalized = true;
        emit BatchFinalized(id);
        (bool sent,) = b.aggregator.call{value: bond}("");
        if (!sent) revert TransferFailed();
    }

    /// @dev Mark slashed, pay half the bond (plus `extra`, a returned deposit) to `to`, burn the rest.
    function _slash(uint256 id, Batch storage b, address to, uint256 index, uint256 extra) internal {
        b.slashed = true;
        emit BatchSlashed(id, to, index);
        uint256 reward = bond / 2;
        (bool sent,) = BURN.call{value: bond - reward}("");
        if (!sent) revert TransferFailed();
        _pay(to, reward + extra);
    }

    /// @dev Push `amount` with a fixed gas budget and no return-data copy; credit it if the push fails.
    function _pay(address to, uint256 amount) internal {
        if (amount == 0) return;
        bool ok;
        assembly ("memory-safe") {
            ok := call(PAYOUT_GAS, to, amount, 0, 0, 0, 0)
        }
        if (!ok) {
            credits[to] += amount;
            totalCredits += amount;
            emit PaymentDeferred(to, amount);
        }
    }

    function isAccepted(uint256 id, bytes32 leaf, uint256 index, bytes32[] calldata proof)
        external
        view
        returns (bool)
    {
        Batch storage b = batches[id];
        return b.finalized && !b.slashed && _inBatch(b, leaf, index, proof);
    }

    /// @dev Membership = one of the batch's `count` real leaves: index < count and a proof of exactly the tree's
    ///      depth. Without this an internal node (shorter proof), a zero padding leaf (index >= count) or an
    ///      index with extra high bits would also verify against the root.
    function _inBatch(Batch storage b, bytes32 leaf, uint256 index, bytes32[] calldata proof)
        internal
        view
        returns (bool)
    {
        uint256 count = b.count;
        if (index >= count || proof.length != depthOf(count)) return false;
        return computeRoot(leaf, index, proof) == b.root;
    }

    /// @notice Depth of the zero-padded tree over `count` leaves (smallest d with 2^d >= count; 0 for count <= 1).
    function depthOf(uint256 count) public pure returns (uint256 d) {
        while ((uint256(1) << d) < count) d++;
    }

    // ---- client helpers ----

    function leafOf(bytes32 pkHash, bytes32 m, bytes calldata sig) public pure returns (bytes32) {
        return keccak256(abi.encodePacked(pkHash, m, keccak256(sig)));
    }

    function messageOf(uint256 chainId, address aggregator, bytes32 pkHash, bytes32 nextPkHash, bytes32 payloadHash)
        public
        pure
        returns (bytes32)
    {
        return keccak256(abi.encode(chainId, aggregator, pkHash, nextPkHash, payloadHash));
    }

    /// @notice Merkle root from a leaf, its index, and bottom-up siblings. Bit i of index = 1 means right child.
    function computeRoot(bytes32 leaf, uint256 index, bytes32[] calldata proof) public pure returns (bytes32 node) {
        node = leaf;
        for (uint256 i = 0; i < proof.length; i++) {
            if ((index >> i) & 1 == 1) {
                node = keccak256(abi.encodePacked(proof[i], node));
            } else {
                node = keccak256(abi.encodePacked(node, proof[i]));
            }
        }
    }
}
