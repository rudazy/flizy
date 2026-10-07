// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IFlizyMintable} from "./IFlizyMintable.sol";

interface IERC721ReceiverCollection {
    function onERC721Received(address operator, address from, uint256 tokenId, bytes calldata data)
        external
        returns (bytes4);
}

/**
 * @title FlizyCollection
 * @notice Flizy-native ERC-721. Single-image collection: every token shares one
 * artwork and is named "<name> #<id>". Metadata is built on chain as base64
 * JSON, so it cannot change or disappear. The creator picks the supply at
 * deploy, up to MAX_SUPPLY_CAP, and it can never be raised. Only the FlizyDrop set at deploy can mint, so the mint
 * rules (phases, allowlist, price, limits) are whatever the owner configures
 * on FlizyDrop and nothing else.
 *
 * Creator royalty is ERC-2981, capped at MAX_ROYALTY_BPS. Ownership moves in
 * two steps (transferOwnership, then acceptOwnership).
 */
contract FlizyCollection is IFlizyMintable {
    /// @notice Hard cap for Flizy-native collections.
    uint256 public constant MAX_SUPPLY_CAP = 10_000;
    /// @notice Highest royalty, in basis points: 10%. Same as FlizyMarketplace.
    uint96 public constant MAX_ROYALTY_BPS = 1000;
    /// @notice Most tokens one mintTo call may create.
    uint256 public constant MAX_BATCH = 20;
    uint256 private constant BPS = 10_000;

    string public name;
    string public symbol;
    /// @notice The one artwork every token uses: an https:// or ipfs:// URL.
    string public image;
    uint256 public immutable override maxSupply;
    address public immutable override flizyMinter;

    address public override owner;
    address public pendingOwner;
    uint256 public override totalSupply;

    address public royaltyReceiver;
    uint96 public royaltyBps;

    mapping(uint256 => address) private _ownerOf;
    mapping(address => uint256) private _balanceOf;
    mapping(uint256 => address) private _tokenApproval;
    mapping(address => mapping(address => bool)) private _operatorApproval;

    event Transfer(address indexed from, address indexed to, uint256 indexed tokenId);
    event Approval(address indexed owner, address indexed spender, uint256 indexed tokenId);
    event ApprovalForAll(address indexed owner, address indexed operator, bool approved);
    event RoyaltyUpdated(address indexed receiver, uint96 bps);
    event OwnershipTransferStarted(address indexed previousOwner, address indexed newOwner);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);

    error NotOwner();
    error NotMinter();
    error ZeroAddress();
    error BadText();
    error BadImage();
    error BadSupply();
    error BadCount();
    error SoldOut();
    error RoyaltyTooHigh();
    error NotTokenOwner();
    error NotAuthorized();
    error SameAddress();
    error UnsafeRecipient();

    constructor(
        string memory name_,
        string memory symbol_,
        uint256 maxSupply_,
        string memory image_,
        address owner_,
        address minter_,
        address royaltyReceiver_,
        uint96 royaltyBps_
    ) {
        if (owner_ == address(0) || minter_ == address(0)) revert ZeroAddress();
        if (!_safeText(bytes(name_), 64) || !_safeText(bytes(symbol_), 16)) revert BadText();
        if (!_safeImage(bytes(image_))) revert BadImage();
        if (maxSupply_ == 0 || maxSupply_ > MAX_SUPPLY_CAP) revert BadSupply();
        if (royaltyBps_ > MAX_ROYALTY_BPS) revert RoyaltyTooHigh();
        if (royaltyBps_ > 0 && royaltyReceiver_ == address(0)) revert ZeroAddress();
        name = name_;
        symbol = symbol_;
        image = image_;
        maxSupply = maxSupply_;
        flizyMinter = minter_;
        owner = owner_;
        royaltyReceiver = royaltyReceiver_;
        royaltyBps = royaltyBps_;
        emit OwnershipTransferred(address(0), owner_);
        emit RoyaltyUpdated(royaltyReceiver_, royaltyBps_);
    }

    // ------------------------------------------------------------------ mint

    function mintTo(address to, uint256 quantity) external override returns (uint256 firstTokenId) {
        if (msg.sender != flizyMinter) revert NotMinter();
        if (to == address(0)) revert ZeroAddress();
        if (quantity == 0 || quantity > MAX_BATCH) revert BadCount();
        uint256 next = totalSupply;
        if (next + quantity > maxSupply) revert SoldOut();
        firstTokenId = next + 1;
        _balanceOf[to] += quantity;
        for (uint256 i = 0; i < quantity; i++) {
            next += 1;
            _ownerOf[next] = to;
            emit Transfer(address(0), to, next);
        }
        totalSupply = next;
    }

    // --------------------------------------------------------------- ERC-721

    function supportsInterface(bytes4 id) external pure returns (bool) {
        return id == 0x01ffc9a7 // ERC-165
            || id == 0x80ac58cd // ERC-721
            || id == 0x5b5e139f // ERC-721 Metadata
            || id == 0x2a55205a; // ERC-2981
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
        ownerOf(tokenId);
        return _tokenApproval[tokenId];
    }

    function isApprovedForAll(address account, address operator) external view returns (bool) {
        return _operatorApproval[account][operator];
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
        if (to == address(0)) revert ZeroAddress();
        address of_ = ownerOf(tokenId);
        if (from != of_) revert NotTokenOwner();
        if (msg.sender != of_ && msg.sender != _tokenApproval[tokenId] && !_operatorApproval[of_][msg.sender]) {
            revert NotAuthorized();
        }
        delete _tokenApproval[tokenId];
        _balanceOf[from] -= 1;
        _balanceOf[to] += 1;
        _ownerOf[tokenId] = to;
        emit Transfer(from, to, tokenId);
    }

    function safeTransferFrom(address from, address to, uint256 tokenId) external {
        safeTransferFrom(from, to, tokenId, "");
    }

    function safeTransferFrom(address from, address to, uint256 tokenId, bytes memory data) public {
        transferFrom(from, to, tokenId);
        if (to.code.length > 0) {
            try IERC721ReceiverCollection(to).onERC721Received(msg.sender, from, tokenId, data) returns (bytes4 r) {
                if (r != IERC721ReceiverCollection.onERC721Received.selector) revert UnsafeRecipient();
            } catch {
                revert UnsafeRecipient();
            }
        }
    }

    /// @notice On-chain JSON: {"name":"<name> #<id>","image":"<image>"}, base64.
    function tokenURI(uint256 tokenId) external view virtual returns (string memory) {
        ownerOf(tokenId);
        bytes memory json = abi.encodePacked(
            '{"name":"', name, " #", _toString(tokenId), '","image":"', image, '"}'
        );
        return string(abi.encodePacked("data:application/json;base64,", _base64(json)));
    }

    // --------------------------------------------------------------- ERC-2981

    function royaltyInfo(uint256, uint256 salePrice) external view returns (address, uint256) {
        return (royaltyReceiver, (salePrice * royaltyBps) / BPS);
    }

    function setRoyalty(address receiver, uint96 bps) external {
        if (msg.sender != owner) revert NotOwner();
        if (bps > MAX_ROYALTY_BPS) revert RoyaltyTooHigh();
        if (bps > 0 && receiver == address(0)) revert ZeroAddress();
        royaltyReceiver = receiver;
        royaltyBps = bps;
        emit RoyaltyUpdated(receiver, bps);
    }

    // -------------------------------------------------------------- ownership

    function transferOwnership(address next) external {
        if (msg.sender != owner) revert NotOwner();
        pendingOwner = next;
        emit OwnershipTransferStarted(owner, next);
    }

    function acceptOwnership() external {
        if (msg.sender != pendingOwner || msg.sender == address(0)) revert NotOwner();
        emit OwnershipTransferred(owner, msg.sender);
        owner = msg.sender;
        pendingOwner = address(0);
    }

    // --------------------------------------------------------------- internal

    /// @dev Printable ASCII without the two characters that would break the JSON.
    function _safeText(bytes memory s, uint256 maxLen) private pure returns (bool) {
        if (s.length == 0 || s.length > maxLen) return false;
        for (uint256 i = 0; i < s.length; i++) {
            bytes1 c = s[i];
            if (c < 0x20 || c > 0x7e || c == '"' || c == "\\") return false;
        }
        return true;
    }

    /// @dev https:// or ipfs://, printable ASCII, no quote, backslash or space.
    function _safeImage(bytes memory s) internal pure returns (bool) {
        if (!_safeText(s, 512)) return false;
        for (uint256 i = 0; i < s.length; i++) {
            if (s[i] == " ") return false;
        }
        return _startsWith(s, "https://") || _startsWith(s, "ipfs://");
    }

    function _startsWith(bytes memory s, bytes memory prefix) private pure returns (bool) {
        if (s.length <= prefix.length) return false;
        for (uint256 i = 0; i < prefix.length; i++) {
            if (s[i] != prefix[i]) return false;
        }
        return true;
    }

    function _toString(uint256 value) internal pure returns (string memory) {
        if (value == 0) return "0";
        uint256 digits;
        for (uint256 v = value; v != 0; v /= 10) digits++;
        bytes memory out = new bytes(digits);
        while (value != 0) {
            digits -= 1;
            out[digits] = bytes1(uint8(48 + (value % 10)));
            value /= 10;
        }
        return string(out);
    }

    bytes1 private constant _PAD = 0x3d; // "="
    bytes private constant _B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

    /// @dev Standard base64 with padding.
    function _base64(bytes memory data) private pure returns (string memory) {
        if (data.length == 0) return "";
        bytes memory out = new bytes(4 * ((data.length + 2) / 3));
        uint256 j;
        for (uint256 i = 0; i < data.length; i += 3) {
            uint256 a = uint8(data[i]);
            uint256 b = i + 1 < data.length ? uint8(data[i + 1]) : 0;
            uint256 c = i + 2 < data.length ? uint8(data[i + 2]) : 0;
            uint256 triple = (a << 16) | (b << 8) | c;
            out[j++] = _B64[(triple >> 18) & 0x3f];
            out[j++] = _B64[(triple >> 12) & 0x3f];
            out[j++] = i + 1 < data.length ? _B64[(triple >> 6) & 0x3f] : _PAD;
            out[j++] = i + 2 < data.length ? _B64[triple & 0x3f] : _PAD;
        }
        return string(out);
    }
}
