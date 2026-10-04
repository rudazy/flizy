// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IFlizyMintable} from "./IFlizyMintable.sol";

/**
 * @title FlizyDrop
 * @notice Runs the mint for every Flizy-managed collection: an allowlist phase,
 * a public phase, or both, each with its own price, a per-wallet limit, and a
 * shared end time. The collection's own owner() configures it; the collection
 * must name this contract as its flizyMinter(). Supply is enforced by the
 * collection.
 *
 * Allowlist: a Merkle root over (collection, wallet, allowance) leaves, built
 * by Flizy from the creator's list (Flizy usernames resolved to wallets, pasted
 * addresses, CSV). A wallet mints up to its allowance during the allowlist
 * window, and separately up to the public limit once public mint is live.
 *
 * Payment is exact: price x quantity. A paid mint sends FEE_BPS (2%, fixed) to
 * the Flizy fee recipient and the rest to the creator's payout address. A free
 * mint takes no fee and accepts no ETH. Payouts are pushed with a gas limit; a
 * recipient that cannot take ETH is credited and claims it with withdraw().
 *
 * The Flizy owner can pause new mints everywhere; a collection owner can pause
 * their own drop. Withdrawals are never paused.
 */
contract FlizyDrop {
    /// @notice Flizy fee on paid mints, in basis points. Fixed: 2%.
    uint256 public constant FEE_BPS = 200;
    /// @notice Most tokens one mint call may request.
    uint256 public constant MAX_PER_TX = 20;
    /// @dev Gas forwarded on a pushed payout. Enough for a smart account receive().
    uint256 private constant PAYOUT_GAS = 50_000;
    uint256 private constant BPS = 10_000;

    /**
     * A phase is off when its start is 0. mintEnd 0 means no end time.
     * The allowlist window is [allowlistStart, allowlistEnd); public is
     * [publicStart, mintEnd). Both stop at mintEnd.
     */
    struct Config {
        uint64 allowlistStart;
        uint64 allowlistEnd;
        uint64 publicStart;
        uint64 mintEnd;
        uint128 allowlistPrice;
        uint128 publicPrice;
        uint32 publicLimit;
        bytes32 merkleRoot;
        address payout;
    }

    struct Drop {
        Config config;
        bool configured;
        bool paused;
    }

    address public owner;
    address public pendingOwner;
    address public feeRecipient;
    bool public paused;

    mapping(address => Drop) private _drops;
    mapping(address => mapping(address => uint256)) public allowlistMinted;
    mapping(address => mapping(address => uint256)) public publicMinted;
    /// @notice ETH owed to an address whose pushed payout failed.
    mapping(address => uint256) public credits;

    uint256 private _lock = 1;

    event DropConfigured(address indexed collection, address indexed by, Config config);
    event RootSet(address indexed collection, bytes32 root);
    event DropPaused(address indexed collection, bool paused);
    event Minted(
        address indexed collection,
        address indexed wallet,
        bool allowlist,
        uint256 quantity,
        uint256 firstTokenId,
        uint256 paid,
        uint256 fee
    );
    event PaymentDeferred(address indexed to, uint256 amount);
    event Withdrawn(address indexed to, uint256 amount);
    event FeeRecipientUpdated(address indexed feeRecipient);
    event PausedSet(bool paused);
    event OwnershipTransferStarted(address indexed previousOwner, address indexed newOwner);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);

    error NotOwner();
    error NotCollectionOwner();
    error NotFlizyMinter();
    error ZeroAddress();
    error BadSchedule();
    error BadLimit();
    error NotConfigured();
    error Paused();
    error NotLive();
    error BadQuantity();
    error WrongPayment();
    error NotOnAllowlist();
    error OverLimit();
    error MintFailed();
    error Reentrancy();
    error TransferFailed();
    error NothingToWithdraw();

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    modifier nonReentrant() {
        if (_lock != 1) revert Reentrancy();
        _lock = 2;
        _;
        _lock = 1;
    }

    constructor(address feeRecipient_) {
        if (feeRecipient_ == address(0)) revert ZeroAddress();
        owner = msg.sender;
        feeRecipient = feeRecipient_;
        emit OwnershipTransferred(address(0), msg.sender);
        emit FeeRecipientUpdated(feeRecipient_);
    }

    // ------------------------------------------------------------ creator

    /// @notice Set or replace the whole drop. Only the collection's owner().
    function configure(address collection, Config calldata config) external {
        _requireCollectionOwner(collection);
        _checkConfig(config);
        Drop storage d = _drops[collection];
        d.config = config;
        d.configured = true;
        emit DropConfigured(collection, msg.sender, config);
        emit RootSet(collection, config.merkleRoot);
    }

    /// @notice Publish a new allowlist without touching the rest of the drop.
    function setMerkleRoot(address collection, bytes32 root) external {
        _requireCollectionOwner(collection);
        Drop storage d = _drops[collection];
        if (!d.configured) revert NotConfigured();
        d.config.merkleRoot = root;
        emit RootSet(collection, root);
    }

    function setDropPaused(address collection, bool value) external {
        _requireCollectionOwner(collection);
        if (!_drops[collection].configured) revert NotConfigured();
        _drops[collection].paused = value;
        emit DropPaused(collection, value);
    }

    // --------------------------------------------------------------- mint

    function mintAllowlist(address collection, uint256 quantity, uint256 allowance, bytes32[] calldata proof)
        external
        payable
        nonReentrant
        returns (uint256 firstTokenId)
    {
        Config memory c = _liveConfig(collection);
        if (c.allowlistStart == 0 || block.timestamp < c.allowlistStart || block.timestamp >= c.allowlistEnd) {
            revert NotLive();
        }
        if (c.merkleRoot == bytes32(0)) revert NotOnAllowlist();
        bytes32 leaf = keccak256(bytes.concat(keccak256(abi.encode(collection, msg.sender, allowance))));
        if (!_verify(proof, c.merkleRoot, leaf)) revert NotOnAllowlist();
        _checkQuantity(quantity);
        uint256 used = allowlistMinted[collection][msg.sender] + quantity;
        if (used > allowance) revert OverLimit();
        allowlistMinted[collection][msg.sender] = used;
        firstTokenId = _mintAndPay(collection, quantity, c.allowlistPrice, c.payout, true);
    }

    function mintPublic(address collection, uint256 quantity)
        external
        payable
        nonReentrant
        returns (uint256 firstTokenId)
    {
        Config memory c = _liveConfig(collection);
        if (c.publicStart == 0 || block.timestamp < c.publicStart) revert NotLive();
        _checkQuantity(quantity);
        uint256 used = publicMinted[collection][msg.sender] + quantity;
        if (used > c.publicLimit) revert OverLimit();
        publicMinted[collection][msg.sender] = used;
        firstTokenId = _mintAndPay(collection, quantity, c.publicPrice, c.payout, false);
    }

    /// @notice Claim ETH from payouts that could not be pushed.
    function withdraw() external nonReentrant {
        uint256 amount = credits[msg.sender];
        if (amount == 0) revert NothingToWithdraw();
        credits[msg.sender] = 0;
        (bool ok,) = msg.sender.call{value: amount}("");
        if (!ok) revert TransferFailed();
        emit Withdrawn(msg.sender, amount);
    }

    // -------------------------------------------------------------- views

    function getDrop(address collection) external view returns (Config memory config, bool configured, bool dropPaused) {
        Drop storage d = _drops[collection];
        return (d.config, d.configured, d.paused);
    }

    // -------------------------------------------------------------- admin

    function setFeeRecipient(address next) external onlyOwner {
        if (next == address(0)) revert ZeroAddress();
        feeRecipient = next;
        emit FeeRecipientUpdated(next);
    }

    function setPaused(bool next) external onlyOwner {
        paused = next;
        emit PausedSet(next);
    }

    function transferOwnership(address next) external onlyOwner {
        pendingOwner = next;
        emit OwnershipTransferStarted(owner, next);
    }

    function acceptOwnership() external {
        if (msg.sender != pendingOwner || msg.sender == address(0)) revert NotOwner();
        emit OwnershipTransferred(owner, msg.sender);
        owner = msg.sender;
        pendingOwner = address(0);
    }

    // ----------------------------------------------------------- internal

    function _requireCollectionOwner(address collection) private view {
        if (collection.code.length == 0) revert NotFlizyMinter();
        address minter;
        address collectionOwner;
        try IFlizyMintable(collection).flizyMinter() returns (address m) {
            minter = m;
        } catch {
            revert NotFlizyMinter();
        }
        if (minter != address(this)) revert NotFlizyMinter();
        try IFlizyMintable(collection).owner() returns (address o) {
            collectionOwner = o;
        } catch {
            revert NotCollectionOwner();
        }
        if (msg.sender != collectionOwner) revert NotCollectionOwner();
    }

    function _checkConfig(Config calldata c) private pure {
        if (c.payout == address(0)) revert ZeroAddress();
        if (c.allowlistStart == 0 && c.publicStart == 0) revert BadSchedule();
        if (c.allowlistStart != 0) {
            if (c.allowlistEnd <= c.allowlistStart) revert BadSchedule();
            if (c.mintEnd != 0 && c.allowlistEnd > c.mintEnd) revert BadSchedule();
        }
        if (c.publicStart != 0) {
            if (c.mintEnd != 0 && c.mintEnd <= c.publicStart) revert BadSchedule();
            if (c.publicLimit == 0) revert BadLimit();
        }
    }

    function _liveConfig(address collection) private view returns (Config memory c) {
        if (paused) revert Paused();
        Drop storage d = _drops[collection];
        if (!d.configured) revert NotConfigured();
        if (d.paused) revert Paused();
        c = d.config;
        if (c.mintEnd != 0 && block.timestamp >= c.mintEnd) revert NotLive();
    }

    function _checkQuantity(uint256 quantity) private pure {
        if (quantity == 0 || quantity > MAX_PER_TX) revert BadQuantity();
    }

    /// @dev Counters are already updated. Mints, confirms the supply moved by
    /// exactly `quantity`, then pays. Exact payment; free mints take no ETH.
    function _mintAndPay(address collection, uint256 quantity, uint256 price, address payout, bool allowlist)
        private
        returns (uint256 firstTokenId)
    {
        uint256 total = price * quantity;
        if (msg.value != total) revert WrongPayment();
        IFlizyMintable token = IFlizyMintable(collection);
        uint256 before = token.totalSupply();
        firstTokenId = token.mintTo(msg.sender, quantity);
        if (token.totalSupply() != before + quantity) revert MintFailed();
        uint256 fee = (total * FEE_BPS) / BPS;
        _pay(feeRecipient, fee);
        _pay(payout, total - fee);
        emit Minted(collection, msg.sender, allowlist, quantity, firstTokenId, total, fee);
    }

    function _pay(address to, uint256 amount) private {
        if (amount == 0) return;
        (bool ok,) = to.call{value: amount, gas: PAYOUT_GAS}("");
        if (!ok) {
            credits[to] += amount;
            emit PaymentDeferred(to, amount);
        }
    }

    /// @dev Sorted-pair Merkle proof, as OpenZeppelin MerkleProof.
    function _verify(bytes32[] calldata proof, bytes32 root, bytes32 leaf) private pure returns (bool) {
        bytes32 h = leaf;
        for (uint256 i = 0; i < proof.length; i++) {
            bytes32 p = proof[i];
            h = h < p ? keccak256(abi.encodePacked(h, p)) : keccak256(abi.encodePacked(p, h));
        }
        return h == root;
    }
}
