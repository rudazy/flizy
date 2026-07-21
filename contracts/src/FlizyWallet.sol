// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * Flizy smart wallet (Phase 2/3).
 * - Owner controls rules (allowlist, session key, routers).
 * - Session key may swap via approved routers and transfer only to allowlisted addresses.
 * - Enforcement is on-chain so a bot/server compromise cannot drain to strangers.
 */

interface IERC20 {
    function transfer(address to, uint256 amount) external returns (bool);
    function approve(address spender, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
}

contract FlizyWallet {
    address public owner;
    address public sessionKey;

    mapping(address => bool) public trusted;
    mapping(address => bool) public approvedRouters;

    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);
    event SessionKeyUpdated(address indexed sessionKey);
    event TrustedUpdated(address indexed target, bool allowed);
    event RouterUpdated(address indexed router, bool allowed);
    event Executed(address indexed caller, address indexed to, uint256 value, bytes data);
    event NativeTransfer(address indexed to, uint256 amount);

    error NotOwner();
    error NotAuthorized();
    error NotTrusted();
    error RouterNotApproved();
    error ZeroAddress();
    error CallFailed();

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    modifier onlyOwnerOrSession() {
        if (msg.sender != owner && msg.sender != sessionKey) revert NotAuthorized();
        _;
    }

    constructor(address owner_, address sessionKey_) {
        if (owner_ == address(0)) revert ZeroAddress();
        owner = owner_;
        sessionKey = sessionKey_;
        emit OwnershipTransferred(address(0), owner_);
        emit SessionKeyUpdated(sessionKey_);
    }

    receive() external payable {}

    function transferOwnership(address newOwner) external onlyOwner {
        if (newOwner == address(0)) revert ZeroAddress();
        emit OwnershipTransferred(owner, newOwner);
        owner = newOwner;
    }

    function setSessionKey(address newSession) external onlyOwner {
        sessionKey = newSession;
        emit SessionKeyUpdated(newSession);
    }

    function setTrusted(address target, bool allowed) external onlyOwner {
        if (target == address(0)) revert ZeroAddress();
        trusted[target] = allowed;
        emit TrustedUpdated(target, allowed);
    }

    function setTrustedBatch(address[] calldata targets, bool allowed) external onlyOwner {
        uint256 len = targets.length;
        for (uint256 i = 0; i < len; i++) {
            address t = targets[i];
            if (t == address(0)) revert ZeroAddress();
            trusted[t] = allowed;
            emit TrustedUpdated(t, allowed);
        }
    }

    function setApprovedRouter(address router, bool allowed) external onlyOwner {
        if (router == address(0)) revert ZeroAddress();
        approvedRouters[router] = allowed;
        emit RouterUpdated(router, allowed);
    }

    /// @notice Native transfer. Session may only send to trusted addresses.
    function transferNative(address to, uint256 amount) external onlyOwnerOrSession {
        if (msg.sender == sessionKey && !trusted[to]) revert NotTrusted();
        (bool ok, ) = to.call{value: amount}("");
        if (!ok) revert CallFailed();
        emit NativeTransfer(to, amount);
    }

    /// @notice ERC-20 transfer. Session may only send to trusted addresses.
    function transferToken(address token, address to, uint256 amount) external onlyOwnerOrSession {
        if (msg.sender == sessionKey && !trusted[to]) revert NotTrusted();
        bool ok = IERC20(token).transfer(to, amount);
        if (!ok) revert CallFailed();
    }

    /// @notice Call an approved DEX router (swaps stay in wallet). Session allowed.
    function swapViaRouter(address router, uint256 value, bytes calldata data)
        external
        onlyOwnerOrSession
        returns (bytes memory result)
    {
        if (!approvedRouters[router]) revert RouterNotApproved();
        (bool ok, bytes memory ret) = router.call{value: value}(data);
        if (!ok) revert CallFailed();
        emit Executed(msg.sender, router, value, data);
        return ret;
    }

    /// @notice Owner-only arbitrary execute (rule-changing / recovery).
    function execute(address to, uint256 value, bytes calldata data)
        external
        onlyOwner
        returns (bytes memory result)
    {
        (bool ok, bytes memory ret) = to.call{value: value}(data);
        if (!ok) revert CallFailed();
        emit Executed(msg.sender, to, value, data);
        return ret;
    }
}
