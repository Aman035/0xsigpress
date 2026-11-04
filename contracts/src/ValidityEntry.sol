// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// The part of SigpressBindV2Gate (experiments/k10-terminal/binding-v2/src) this entry relies on:
/// `accepted[keccak256(abi.encode(slot, left.pubkeys, left.messages, right.pubkeys, right.messages))]` is set
/// only after the gate has checked a terminal STARK proving that every (pubkey_i, message_i) in that calldata
/// carries a valid leanXMSS signature at `slot`.
interface IBindV2Gate {
    function accepted(bytes32 commitment) external view returns (bool);
}

/// Minimal smart account for the validity path. Its leanXMSS key is registered with the entry by the account
/// itself, in its constructor, and can never change. Only the entry can make it call out.
contract ValidityAccount {
    address public immutable entry;

    error OnlyEntry();

    constructor(address entry_, bytes32 pubkey) payable {
        entry = entry_;
        ValidityEntry(entry_).registerKey(pubkey);
    }

    function exec(address target, uint256 value, bytes calldata data) external returns (bool ok) {
        if (msg.sender != entry) revert OnlyEntry();
        (ok,) = target.call{value: value}(data);
    }

    receive() external payable {}
}

/// Executes ops whose (pubkey, message) pair is in a batch the SigpressBindV2Gate has accepted.
///
/// An op of `account` runs only if:
///  - `account` registered pubkey `pk` (set once, by the account itself: `registerKey` from its constructor),
///  - the accepted batch has `pk` at (side, index),
///  - the message at (side, index) is `opHash(account, nonce, target, value, data)` with the account's next
///    nonce (so an op runs at most once, and only in order).
/// The gate stores only the keccak commitment of the batch, so `execute` takes the batch's pubkeys and messages
/// again (64 B per signer of calldata) and recomputes it. Filler signers (padding to the verifier's fixed shape)
/// simply have no op.
contract ValidityEntry {
    struct Signers {
        bytes32[] pubkeys; // gate encoding: 8 big-endian uint32 KoalaBear limbs
        bytes32[] messages;
    }

    struct Op {
        address account;
        uint256 nonce;
        address target;
        uint256 value;
        bytes data;
        uint8 side; // 0 = left batch, 1 = right batch
        uint32 index; // position in that batch
    }

    bytes32 public constant OP_TAG = keccak256("sigpress-validity-op-v1");
    /// Gas each op's call gets (fixed, so one op can't starve the rest; the batch reverts if it can't pay it).
    uint256 public constant OP_GAS = 300_000;

    IBindV2Gate public immutable gate;
    mapping(address account => bytes32 pubkey) public keyOf;
    mapping(address account => uint256) public nonceOf;

    event KeyRegistered(address indexed account, bytes32 pubkey);
    event AccountCreated(address indexed account, bytes32 pubkey, bytes32 salt);
    event OpExecuted(bytes32 indexed commitment, address indexed account, uint256 nonce, bool success);

    error ZeroKey();
    error KeyAlreadySet();
    error NotAccepted();
    error BadIndex();
    error NoKey();
    error NotAccount();
    error WrongPubkey();
    error WrongMessage();
    error BadNonce();
    error InsufficientGas();

    constructor(IBindV2Gate gate_) {
        gate = gate_;
    }

    // ------------------------------------------------------------------ registry

    /// The caller binds itself to `pubkey`, once. ValidityAccount calls this from its constructor.
    function registerKey(bytes32 pubkey) external {
        if (pubkey == 0) revert ZeroKey();
        if (keyOf[msg.sender] != 0) revert KeyAlreadySet();
        keyOf[msg.sender] = pubkey;
        emit KeyRegistered(msg.sender, pubkey);
    }

    /// Deploy the ValidityAccount for (pubkey, salt). Anyone may call it; the account is bound to `pubkey`, so
    /// only the key holder can ever make it do anything.
    function createAccount(bytes32 pubkey, bytes32 salt) external payable returns (address account) {
        account = address(new ValidityAccount{salt: keccak256(abi.encode(pubkey, salt)), value: msg.value}(address(this), pubkey));
        emit AccountCreated(account, pubkey, salt);
    }

    function accountAddress(bytes32 pubkey, bytes32 salt) external view returns (address) {
        bytes32 h = keccak256(
            abi.encodePacked(
                bytes1(0xff),
                address(this),
                keccak256(abi.encode(pubkey, salt)),
                keccak256(abi.encodePacked(type(ValidityAccount).creationCode, abi.encode(address(this), pubkey)))
            )
        );
        return address(uint160(uint256(h)));
    }

    // ------------------------------------------------------------------ views

    /// The 32-byte message the account's key signs for this op.
    function opHash(address account, uint256 nonce, address target, uint256 value, bytes calldata data)
        public
        view
        returns (bytes32)
    {
        return keccak256(abi.encode(OP_TAG, block.chainid, address(this), account, nonce, target, value, keccak256(data)));
    }

    /// Same as SigpressBindV2Gate.batchCommitment.
    function commitmentOf(uint32 slot, Signers calldata left, Signers calldata right) public pure returns (bytes32) {
        return keccak256(abi.encode(slot, left.pubkeys, left.messages, right.pubkeys, right.messages));
    }

    // ------------------------------------------------------------------ execution

    /// Run `ops` from the accepted batch (slot, left, right). Permissionless: the proof, not the caller, is what
    /// authorises each op. Any mismatch reverts the whole call; a failing op *call* does not (its nonce is used).
    function execute(uint32 slot, Signers calldata left, Signers calldata right, Op[] calldata ops)
        external
        returns (bytes32 commitment)
    {
        commitment = commitmentOf(slot, left, right);
        if (!gate.accepted(commitment)) revert NotAccepted();
        for (uint256 i; i < ops.length; ++i) {
            Op calldata op = ops[i];
            if (op.side > 1) revert BadIndex();
            Signers calldata s = op.side == 0 ? left : right;
            if (op.index >= s.pubkeys.length || s.messages.length != s.pubkeys.length) revert BadIndex();
            bytes32 pk = keyOf[op.account];
            if (pk == 0) revert NoKey();
            if (s.pubkeys[op.index] != pk) revert WrongPubkey();
            if (op.nonce != nonceOf[op.account]) revert BadNonce();
            if (s.messages[op.index] != opHash(op.account, op.nonce, op.target, op.value, op.data)) revert WrongMessage();
            if (op.account.code.length == 0) revert NotAccount();
            nonceOf[op.account] = op.nonce + 1;
            if (gasleft() < (OP_GAS * 64) / 63 + 20_000) revert InsufficientGas();
            (bool ok, bytes memory ret) =
                op.account.call{gas: OP_GAS}(abi.encodeCall(ValidityAccount.exec, (op.target, op.value, op.data)));
            bool success = ok && ret.length == 32 && abi.decode(ret, (bool));
            emit OpExecuted(commitment, op.account, op.nonce, success);
        }
    }
}
