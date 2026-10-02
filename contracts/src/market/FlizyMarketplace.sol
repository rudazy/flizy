// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IERC721Market {
    function ownerOf(uint256 tokenId) external view returns (address);
    function getApproved(uint256 tokenId) external view returns (address);
    function transferFrom(address from, address to, uint256 tokenId) external;
    function supportsInterface(bytes4 interfaceId) external view returns (bool);
}

interface IERC2981Market {
    function royaltyInfo(uint256 tokenId, uint256 salePrice) external view returns (address, uint256);
}

interface IOwnableMarket {
    function owner() external view returns (address);
}

/**
 * @title FlizyMarketplace
 * @notice ERC-721 marketplace for GIWA. Listings are non-custodial: the NFT stays
 * in the seller's wallet until it sells. A listing needs the marketplace to be
 * approved for that one token (ERC-721 approve, not setApprovalForAll). Every
 * transfer clears that approval, so a listing ends the moment the NFT leaves the
 * wallet and cannot come back if the NFT later returns.
 * Offers escrow ETH in this contract until accepted, cancelled or expired.
 *
 * Every sale pays, in this order: the Flizy fee (FEE_BPS, fixed), the creator
 * royalty (set by the collection owner, else ERC-2981, capped at MAX_ROYALTY_BPS),
 * and the remainder to the seller. The royalty can never exceed the rate the
 * seller agreed to: a listing records the rate when it is made, and accepting an
 * offer names the highest rate the seller accepts. A creator raising the
 * royalty later cannot take more from a sale already agreed. Payouts are pushed with a gas limit; a
 * recipient that cannot take ETH is credited instead and claims it with
 * withdraw(), so no payee can block a sale.
 *
 * The owner can pause new listings, buys, offers and accepts. Cancels, refunds
 * and withdrawals are never paused, so funds can always leave.
 */
contract FlizyMarketplace {
    /// @notice Flizy fee on every sale, in basis points. Fixed: 2%.
    uint256 public constant FEE_BPS = 200;
    /// @notice Highest creator royalty a sale will pay, in basis points: 10%.
    uint256 public constant MAX_ROYALTY_BPS = 1000;
    /// @notice Longest a listing or offer may stay open.
    uint256 public constant MAX_DURATION = 180 days;
    /// @dev Gas forwarded on a pushed payout. Enough for a smart account receive().
    uint256 private constant PAYOUT_GAS = 50_000;
    uint256 private constant BPS = 10_000;
    bytes4 private constant ERC721_INTERFACE = 0x80ac58cd;
    bytes4 private constant ERC2981_INTERFACE = 0x2a55205a;

    struct Listing {
        address seller;
        uint64 expiry;
        /// Royalty rate in force when listed; the sale never pays more than this.
        uint16 royaltyCapBps;
        uint256 price;
    }

    struct Offer {
        address maker;
        uint64 expiry;
        bool anyToken;
        address collection;
        uint256 tokenId;
        uint256 amount;
    }

    struct Royalty {
        address receiver;
        uint16 bps;
        bool set;
    }

    address public owner;
    address public pendingOwner;
    address public feeRecipient;
    bool public paused;
    uint256 public offerCount;

    mapping(address => mapping(uint256 => Listing)) private _listings;
    mapping(uint256 => Offer) private _offers;
    mapping(address => Royalty) private _royalties;
    /// @notice ETH owed to an address whose pushed payout failed.
    mapping(address => uint256) public credits;

    uint256 private _lock = 1;

    event Listed(address indexed collection, uint256 indexed tokenId, address indexed seller, uint256 price, uint64 expiry);
    event ListingCancelled(address indexed collection, uint256 indexed tokenId, address indexed seller);
    event Sold(
        address indexed collection,
        uint256 indexed tokenId,
        address indexed buyer,
        address seller,
        uint256 price,
        uint256 fee,
        uint256 royalty,
        uint256 offerId
    );
    event OfferMade(
        uint256 indexed offerId,
        address indexed collection,
        address indexed maker,
        uint256 tokenId,
        bool anyToken,
        uint256 amount,
        uint64 expiry
    );
    event OfferCancelled(uint256 indexed offerId, address indexed maker);
    event RoyaltySet(address indexed collection, address indexed receiver, uint256 bps);
    event PaymentDeferred(address indexed to, uint256 amount);
    event Withdrawn(address indexed to, uint256 amount);
    event FeeRecipientUpdated(address indexed feeRecipient);
    event PausedSet(bool paused);
    event OwnershipTransferStarted(address indexed previousOwner, address indexed newOwner);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);

    error NotOwner();
    error ZeroAddress();
    error Paused();
    error Reentrancy();
    error NotERC721();
    error NotTokenOwner();
    error NotApproved();
    error BadPrice();
    error BadExpiry();
    error NotListed();
    error ListingExpired();
    error StaleListing();
    error PriceChanged();
    error OwnPurchase();
    error NotCancellable();
    error NoOffer();
    error NotOfferMaker();
    error OfferExpired();
    error WrongToken();
    error AmountChanged();
    error TransferFailed();
    error NotCollectionOwner();
    error RoyaltyTooHigh();
    error RoyaltyRaised();
    error NothingToWithdraw();

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    modifier whenNotPaused() {
        if (paused) revert Paused();
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

    // ---------------------------------------------------------------- listings

    /**
     * @notice List a token you own, or change its price or expiry. The NFT stays
     * in your wallet; the marketplace must be approved for this token with
     * approve(marketplace, tokenId). The current royalty rate is recorded as the
     * most this sale will ever pay.
     */
    function list(address collection, uint256 tokenId, uint256 price, uint64 expiry) external whenNotPaused {
        if (price == 0) revert BadPrice();
        _checkExpiry(expiry);
        _requireERC721(collection);
        IERC721Market nft = IERC721Market(collection);
        if (nft.ownerOf(tokenId) != msg.sender) revert NotTokenOwner();
        if (!_isTokenApproved(collection, tokenId)) revert NotApproved();

        (, uint256 royalty) = royaltyFor(collection, tokenId, price);
        // Rounded up, so the recorded rate covers the royalty quoted at this price.
        uint256 capBps = (royalty * BPS + price - 1) / price;
        // casting to 'uint16' is safe because royaltyFor never exceeds MAX_ROYALTY_BPS (1000)
        // forge-lint: disable-next-line(unsafe-typecast)
        uint16 cap16 = uint16(capBps);
        _listings[collection][tokenId] = Listing({seller: msg.sender, expiry: expiry, royaltyCapBps: cap16, price: price});
        emit Listed(collection, tokenId, msg.sender, price, expiry);
    }

    /**
     * @notice Remove a listing. The seller can always cancel. The token's current
     * owner can clear a listing left behind by a previous owner.
     */
    function cancelListing(address collection, uint256 tokenId) external {
        Listing memory l = _listings[collection][tokenId];
        if (l.seller == address(0)) revert NotListed();
        if (msg.sender != l.seller && msg.sender != _ownerOfOrZero(collection, tokenId)) revert NotCancellable();
        delete _listings[collection][tokenId];
        emit ListingCancelled(collection, tokenId, l.seller);
    }

    /**
     * @notice Buy a listed token. `expectedPrice` is the price the buyer reviewed;
     * the call fails if the listing changed since, so a seller cannot raise the
     * price under a pending purchase.
     */
    function buy(address collection, uint256 tokenId, uint256 expectedPrice)
        external
        payable
        nonReentrant
        whenNotPaused
    {
        Listing memory l = _listings[collection][tokenId];
        if (l.seller == address(0)) revert NotListed();
        if (block.timestamp > l.expiry) revert ListingExpired();
        if (l.price != expectedPrice || msg.value != l.price) revert PriceChanged();
        if (msg.sender == l.seller) revert OwnPurchase();
        if (_ownerOfOrZero(collection, tokenId) != l.seller) revert StaleListing();
        // Operator approval would still move it; only the per-token approval
        // proves the token has not left the wallet since it was listed.
        if (!_isTokenApproved(collection, tokenId)) revert StaleListing();

        delete _listings[collection][tokenId];
        _moveToken(collection, l.seller, msg.sender, tokenId);
        (uint256 fee, uint256 royalty) = _settle(collection, tokenId, l.seller, l.price, l.royaltyCapBps);
        emit Sold(collection, tokenId, msg.sender, l.seller, l.price, fee, royalty, 0);
    }

    // ------------------------------------------------------------------ offers

    /**
     * @notice Offer ETH for one token, or for any token in a collection when
     * `anyToken` is true. The ETH is held here until the offer is accepted or
     * the maker cancels it.
     */
    function makeOffer(address collection, uint256 tokenId, bool anyToken, uint64 expiry)
        external
        payable
        whenNotPaused
        returns (uint256 offerId)
    {
        if (msg.value == 0) revert BadPrice();
        _checkExpiry(expiry);
        _requireERC721(collection);

        offerId = ++offerCount;
        _offers[offerId] = Offer({
            maker: msg.sender,
            expiry: expiry,
            anyToken: anyToken,
            collection: collection,
            tokenId: anyToken ? 0 : tokenId,
            amount: msg.value
        });
        emit OfferMade(offerId, collection, msg.sender, anyToken ? 0 : tokenId, anyToken, msg.value, expiry);
    }

    /// @notice Withdraw an offer and its ETH. Works when paused and after expiry.
    function cancelOffer(uint256 offerId) external nonReentrant {
        Offer memory o = _offers[offerId];
        if (o.maker == address(0)) revert NoOffer();
        if (msg.sender != o.maker) revert NotOfferMaker();
        delete _offers[offerId];
        emit OfferCancelled(offerId, o.maker);
        _pay(o.maker, o.amount);
    }

    /**
     * @notice Sell `tokenId` into an offer. The caller must own it and have
     * approved the marketplace. `expectedAmount` is the amount the seller reviewed;
     * `maxRoyaltyBps` is the highest royalty rate the seller accepts, so a rate
     * raised after they reviewed it reverts the sale instead of paying more.
     */
    function acceptOffer(uint256 offerId, uint256 tokenId, uint256 expectedAmount, uint256 maxRoyaltyBps)
        external
        nonReentrant
        whenNotPaused
    {
        Offer memory o = _offers[offerId];
        if (o.maker == address(0)) revert NoOffer();
        if (block.timestamp > o.expiry) revert OfferExpired();
        if (o.amount != expectedAmount) revert AmountChanged();
        if (!o.anyToken && o.tokenId != tokenId) revert WrongToken();
        if (_ownerOfOrZero(o.collection, tokenId) != msg.sender) revert NotTokenOwner();
        if (msg.sender == o.maker) revert OwnPurchase();
        (, uint256 due) = royaltyFor(o.collection, tokenId, o.amount);
        if (due * BPS > o.amount * maxRoyaltyBps) revert RoyaltyRaised();

        delete _offers[offerId];
        if (_listings[o.collection][tokenId].seller != address(0)) {
            delete _listings[o.collection][tokenId];
            emit ListingCancelled(o.collection, tokenId, msg.sender);
        }
        _moveToken(o.collection, msg.sender, o.maker, tokenId);
        (uint256 fee, uint256 royalty) = _settle(o.collection, tokenId, msg.sender, o.amount, MAX_ROYALTY_BPS);
        emit Sold(o.collection, tokenId, o.maker, msg.sender, o.amount, fee, royalty, offerId);
    }

    // --------------------------------------------------------------- royalties

    /**
     * @notice Set the creator royalty for a collection. Only the collection
     * contract's owner() can call this. bps 0 with any receiver turns it off and
     * stops the ERC-2981 fallback.
     */
    function setRoyalty(address collection, address receiver, uint256 bps) external {
        if (bps > MAX_ROYALTY_BPS) revert RoyaltyTooHigh();
        if (bps > 0 && receiver == address(0)) revert ZeroAddress();
        address collectionOwner;
        try IOwnableMarket(collection).owner() returns (address o) {
            collectionOwner = o;
        } catch {
            revert NotCollectionOwner();
        }
        if (collectionOwner == address(0) || msg.sender != collectionOwner) revert NotCollectionOwner();
        // casting to 'uint16' is safe because bps <= MAX_ROYALTY_BPS (1000) is checked above
        // forge-lint: disable-next-line(unsafe-typecast)
        _royalties[collection] = Royalty({receiver: receiver, bps: uint16(bps), set: true});
        emit RoyaltySet(collection, receiver, bps);
    }

    /**
     * @notice The royalty a sale of `tokenId` at `price` would pay, and to whom.
     * The explicit setting wins; otherwise ERC-2981; never above MAX_ROYALTY_BPS.
     */
    function royaltyFor(address collection, uint256 tokenId, uint256 price)
        public
        view
        returns (address receiver, uint256 amount)
    {
        Royalty memory r = _royalties[collection];
        if (r.set) {
            if (r.bps == 0) return (address(0), 0);
            return (r.receiver, (price * r.bps) / BPS);
        }
        if (!_supports(collection, ERC2981_INTERFACE)) return (address(0), 0);
        try IERC2981Market(collection).royaltyInfo{gas: 50_000}(tokenId, price) returns (address to, uint256 due) {
            if (to == address(0) || due == 0) return (address(0), 0);
            uint256 cap = (price * MAX_ROYALTY_BPS) / BPS;
            return (to, due > cap ? cap : due);
        } catch {
            return (address(0), 0);
        }
    }

    /// @notice The explicit royalty setting for a collection, if any.
    function royaltySetting(address collection) external view returns (address receiver, uint256 bps, bool set) {
        Royalty memory r = _royalties[collection];
        return (r.receiver, r.bps, r.set);
    }

    // --------------------------------------------------------------- payments

    /// @notice Claim ETH from payouts that could not be pushed.
    function withdraw() external nonReentrant {
        uint256 amount = credits[msg.sender];
        if (amount == 0) revert NothingToWithdraw();
        credits[msg.sender] = 0;
        (bool ok,) = msg.sender.call{value: amount}("");
        if (!ok) revert TransferFailed();
        emit Withdrawn(msg.sender, amount);
    }

    // ------------------------------------------------------------------ views

    function getListing(address collection, uint256 tokenId) external view returns (Listing memory) {
        return _listings[collection][tokenId];
    }

    /**
     * @notice True when the listing can be bought right now: present, unexpired,
     * the seller still owns the token and the marketplace is still approved.
     */
    function isListingValid(address collection, uint256 tokenId) external view returns (bool) {
        Listing memory l = _listings[collection][tokenId];
        if (l.seller == address(0) || block.timestamp > l.expiry) return false;
        if (_ownerOfOrZero(collection, tokenId) != l.seller) return false;
        return _isTokenApproved(collection, tokenId);
    }

    function getOffer(uint256 offerId) external view returns (Offer memory) {
        return _offers[offerId];
    }

    // ------------------------------------------------------------------ admin

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

    // --------------------------------------------------------------- internal

    function _checkExpiry(uint64 expiry) private view {
        if (expiry <= block.timestamp || expiry > block.timestamp + MAX_DURATION) revert BadExpiry();
    }

    function _requireERC721(address collection) private view {
        if (collection.code.length == 0 || !_supports(collection, ERC721_INTERFACE)) revert NotERC721();
    }

    function _supports(address collection, bytes4 id) private view returns (bool) {
        try IERC721Market(collection).supportsInterface{gas: 30_000}(id) returns (bool ok) {
            return ok;
        } catch {
            return false;
        }
    }

    /// @dev True when the marketplace holds this token's own approval. Operator
    /// approval (setApprovalForAll) does not count: it survives transfers.
    function _isTokenApproved(address collection, uint256 tokenId) private view returns (bool) {
        try IERC721Market(collection).getApproved(tokenId) returns (address one) {
            return one == address(this);
        } catch {
            return false;
        }
    }

    function _ownerOfOrZero(address collection, uint256 tokenId) private view returns (address) {
        try IERC721Market(collection).ownerOf(tokenId) returns (address o) {
            return o;
        } catch {
            return address(0);
        }
    }

    /// @dev Moves the token and confirms it arrived, so a collection that does not
    /// really transfer cannot take payment for nothing.
    function _moveToken(address collection, address from, address to, uint256 tokenId) private {
        IERC721Market(collection).transferFrom(from, to, tokenId);
        if (_ownerOfOrZero(collection, tokenId) != to) revert TransferFailed();
    }

    /// @dev Pays the fee, the royalty (never above capBps of the price) and the seller.
    function _settle(address collection, uint256 tokenId, address seller, uint256 price, uint256 capBps)
        private
        returns (uint256 fee, uint256 royalty)
    {
        fee = (price * FEE_BPS) / BPS;
        address royaltyTo;
        (royaltyTo, royalty) = royaltyFor(collection, tokenId, price);
        uint256 cap = (price * capBps) / BPS;
        if (royalty > cap) royalty = cap;
        _pay(feeRecipient, fee);
        if (royalty > 0) _pay(royaltyTo, royalty);
        _pay(seller, price - fee - royalty);
    }

    function _pay(address to, uint256 amount) private {
        if (amount == 0) return;
        (bool ok,) = to.call{value: amount, gas: PAYOUT_GAS}("");
        if (!ok) {
            credits[to] += amount;
            emit PaymentDeferred(to, amount);
        }
    }
}
