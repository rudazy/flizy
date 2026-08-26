// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Testnet ERC-721 for Flizy identity send. Cap 500. Owner mints in batches.
/// Not the collections studio. Listed in chat as ticker `giwaforge`.
contract Giwaforge {
    string public constant name = "Giwaforge";
    string public constant symbol = "FORGE";
    uint256 public constant MAX_SUPPLY = 500;
    uint256 public constant MAX_BATCH = 50;

    address public immutable owner;
    uint256 public totalSupply;

    mapping(uint256 => address) private _ownerOf;
    mapping(address => uint256) private _balanceOf;
    mapping(uint256 => address) private _tokenApproval;
    mapping(address => mapping(address => bool)) private _operatorApproval;

    event Transfer(address indexed from, address indexed to, uint256 indexed tokenId);
    event Approval(address indexed owner, address indexed spender, uint256 indexed tokenId);
    event ApprovalForAll(address indexed owner, address indexed operator, bool approved);

    error NotOwner();
    error BadTo();
    error BadCount();
    error Cap();
    error NotTokenOwner();
    error NotAuthorized();
    error ZeroAddress();
    error SameAddress();

    constructor() {
        owner = msg.sender;
    }

    function supportsInterface(bytes4 id) external pure returns (bool) {
        return id == 0x01ffc9a7 || id == 0x80ac58cd || id == 0x5b5e139f;
    }

    function balanceOf(address account) external view returns (uint256) {
        if (account == address(0)) revert ZeroAddress();
        return _balanceOf[account];
    }

    function ownerOf(uint256 tokenId) public view returns (address) {
        address of_ = _ownerOf[tokenId];
        if (of_ == address(0)) revert NotTokenOwner();
        return of_;
    }

    function getApproved(uint256 tokenId) external view returns (address) {
        if (_ownerOf[tokenId] == address(0)) revert NotTokenOwner();
        return _tokenApproval[tokenId];
    }

    function isApprovedForAll(address account, address operator) external view returns (bool) {
        return _operatorApproval[account][operator];
    }

    function tokenURI(uint256 tokenId) external view returns (string memory) {
        if (_ownerOf[tokenId] == address(0)) revert NotTokenOwner();
        return "";
    }

    function mint(address to, uint256 count) external {
        if (msg.sender != owner) revert NotOwner();
        if (to == address(0)) revert BadTo();
        if (count == 0 || count > MAX_BATCH) revert BadCount();
        uint256 next = totalSupply;
        if (next + count > MAX_SUPPLY) revert Cap();
        _balanceOf[to] += count;
        for (uint256 i = 0; i < count; i++) {
            next += 1;
            _ownerOf[next] = to;
            emit Transfer(address(0), to, next);
        }
        totalSupply = next;
    }

    function approve(address spender, uint256 tokenId) external {
        address of_ = ownerOf(tokenId);
        if (msg.sender != of_ && !_operatorApproval[of_][msg.sender]) revert NotAuthorized();
        _tokenApproval[tokenId] = spender;
        emit Approval(of_, spender, tokenId);
    }

    function setApprovalForAll(address operator, bool approved) external {
        if (operator == msg.sender) revert SameAddress();
        _operatorApproval[msg.sender][operator] = approved;
        emit ApprovalForAll(msg.sender, operator, approved);
    }

    function transferFrom(address from, address to, uint256 tokenId) public {
        if (to == address(0)) revert BadTo();
        address of_ = ownerOf(tokenId);
        if (from != of_) revert NotTokenOwner();
        if (
            msg.sender != of_ &&
            msg.sender != _tokenApproval[tokenId] &&
            !_operatorApproval[of_][msg.sender]
        ) revert NotAuthorized();
        _tokenApproval[tokenId] = address(0);
        _balanceOf[from] -= 1;
        _balanceOf[to] += 1;
        _ownerOf[tokenId] = to;
        emit Transfer(from, to, tokenId);
    }

    function safeTransferFrom(address from, address to, uint256 tokenId) external {
        transferFrom(from, to, tokenId);
    }

    function safeTransferFrom(address from, address to, uint256 tokenId, bytes calldata) external {
        transferFrom(from, to, tokenId);
    }
}
