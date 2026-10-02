// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {FlizyMarketplace} from "../src/market/FlizyMarketplace.sol";

/// Minimal ERC-721 with an owner(), for listing, approval and royalty tests.
contract MockNFT {
    address public owner;
    mapping(uint256 => address) public ownerOfToken;
    mapping(uint256 => address) private _approved;
    mapping(address => mapping(address => bool)) private _operators;

    constructor() {
        owner = msg.sender;
    }

    function supportsInterface(bytes4 id) external pure virtual returns (bool) {
        return id == 0x01ffc9a7 || id == 0x80ac58cd;
    }

    function mint(address to, uint256 id) external {
        ownerOfToken[id] = to;
    }

    function burn(uint256 id) external {
        ownerOfToken[id] = address(0);
    }

    function ownerOf(uint256 id) external view returns (address o) {
        o = ownerOfToken[id];
        require(o != address(0), "no token");
    }

    function getApproved(uint256 id) external view virtual returns (address) {
        return _approved[id];
    }

    function isApprovedForAll(address holder, address op) external view virtual returns (bool) {
        return _operators[holder][op];
    }

    function approve(address to, uint256 id) external {
        require(msg.sender == ownerOfToken[id], "not owner");
        _approved[id] = to;
    }

    function setApprovalForAll(address op, bool ok) external {
        _operators[msg.sender][op] = ok;
    }

    function transferFrom(address from, address to, uint256 id) public virtual {
        require(ownerOfToken[id] == from, "wrong from");
        require(
            msg.sender == from || _approved[id] == msg.sender || _operators[from][msg.sender],
            "not allowed"
        );
        _approved[id] = address(0);
        ownerOfToken[id] = to;
    }
}

/// Declares a royalty through ERC-2981.
contract Mock2981NFT is MockNFT {
    address public royaltyTo;
    uint256 public royaltyBps;

    function setRoyalty(address to, uint256 bps) external {
        royaltyTo = to;
        royaltyBps = bps;
    }

    function supportsInterface(bytes4 id) external pure override returns (bool) {
        return id == 0x01ffc9a7 || id == 0x80ac58cd || id == 0x2a55205a;
    }

    function royaltyInfo(uint256, uint256 price) external view returns (address, uint256) {
        return (royaltyTo, (price * royaltyBps) / 10_000);
    }
}

/// Claims ERC-2981 but its royaltyInfo reverts.
contract Broken2981NFT is MockNFT {
    function supportsInterface(bytes4 id) external pure override returns (bool) {
        return id == 0x80ac58cd || id == 0x2a55205a;
    }

    function royaltyInfo(uint256, uint256) external pure returns (address, uint256) {
        revert("broken");
    }
}

/// Only per-token approval exists; the operator check and getApproved revert.
contract RevertingApprovalNFT is MockNFT {
    function isApprovedForAll(address, address) external pure override returns (bool) {
        revert("no operators");
    }

    function getApproved(uint256) external pure override returns (address) {
        revert("no approvals");
    }
}

/// Has code but no supportsInterface.
contract NoIntrospection {}

/// A collection whose transferFrom tries to buy again mid-sale.
contract ReentrantNFT is MockNFT {
    FlizyMarketplace public market;
    uint256 public reenterId;

    function arm(FlizyMarketplace m, uint256 id) external {
        market = m;
        reenterId = id;
    }

    function transferFrom(address from, address to, uint256 id) public override {
        if (address(market) != address(0)) {
            market.buy{value: 0}(address(this), reenterId, 0);
        }
        super.transferFrom(from, to, id);
    }
}

/// A collection that says it transferred but did not.
contract FakeTransferNFT is MockNFT {
    function transferFrom(address, address, uint256) public pure override {}
}

/// No owner() function at all.
contract OwnerlessNFT {
    function supportsInterface(bytes4 id) external pure returns (bool) {
        return id == 0x80ac58cd;
    }
}

/// Refuses every ETH transfer.
contract Rejector {
    function approveOne(MockNFT nft, address op, uint256 id) external {
        nft.approve(op, id);
    }

    function list(FlizyMarketplace m, address c, uint256 id, uint256 price, uint64 expiry) external {
        m.list(c, id, price, expiry);
    }

    function claim(FlizyMarketplace m) external {
        m.withdraw();
    }
}

contract FlizyMarketplaceTest is Test {
    FlizyMarketplace internal market;
    MockNFT internal nft;
    address internal fees = address(0xFEE);
    address internal seller = address(0x5E11);
    address internal buyer = address(0xB0B);
    address internal creator = address(0xC0FFEE);
    uint64 internal expiry;

    function setUp() public {
        vm.warp(1_000_000);
        market = new FlizyMarketplace(fees);
        nft = new MockNFT();
        nft.mint(seller, 1);
        nft.mint(seller, 2);
        vm.startPrank(seller);
        nft.approve(address(market), 1);
        nft.approve(address(market), 2);
        vm.stopPrank();
        expiry = uint64(block.timestamp + 7 days);
        vm.deal(buyer, 100 ether);
    }

    function _list(uint256 id, uint256 price) internal {
        vm.prank(seller);
        market.list(address(nft), id, price, expiry);
    }

    // ---------------------------------------------------------------- constructor

    function testConstructorRejectsZeroFeeRecipient() public {
        vm.expectRevert(FlizyMarketplace.ZeroAddress.selector);
        new FlizyMarketplace(address(0));
    }

    function testFeeIsTwoPercent() public view {
        assertEq(market.FEE_BPS(), 200);
        assertEq(market.MAX_ROYALTY_BPS(), 1000);
    }

    // -------------------------------------------------------------------- list

    function testListStoresListing() public {
        _list(1, 1 ether);
        FlizyMarketplace.Listing memory l = market.getListing(address(nft), 1);
        assertEq(l.seller, seller);
        assertEq(l.price, 1 ether);
        assertEq(l.expiry, expiry);
        assertTrue(market.isListingValid(address(nft), 1));
    }

    function testRelistChangesPrice() public {
        _list(1, 1 ether);
        _list(1, 2 ether);
        assertEq(market.getListing(address(nft), 1).price, 2 ether);
    }

    function testListRequiresOwner() public {
        vm.prank(buyer);
        vm.expectRevert(FlizyMarketplace.NotTokenOwner.selector);
        market.list(address(nft), 1, 1 ether, expiry);
    }

    function testListRequiresApproval() public {
        vm.startPrank(seller);
        nft.approve(address(0), 1);
        vm.expectRevert(FlizyMarketplace.NotApproved.selector);
        market.list(address(nft), 1, 1 ether, expiry);
        vm.stopPrank();
    }

    function testOperatorApprovalIsNotEnoughToList() public {
        vm.startPrank(seller);
        nft.approve(address(0), 1);
        nft.setApprovalForAll(address(market), true);
        vm.expectRevert(FlizyMarketplace.NotApproved.selector);
        market.list(address(nft), 1, 1 ether, expiry);
        vm.stopPrank();
    }

    function testListingRecordsRoyaltyRate() public {
        market.setRoyalty(address(nft), creator, 500);
        _list(1, 1 ether);
        assertEq(market.getListing(address(nft), 1).royaltyCapBps, 500);
    }

    function testListRejectsZeroPrice() public {
        vm.prank(seller);
        vm.expectRevert(FlizyMarketplace.BadPrice.selector);
        market.list(address(nft), 1, 0, expiry);
    }

    function testListRejectsBadExpiry() public {
        vm.startPrank(seller);
        vm.expectRevert(FlizyMarketplace.BadExpiry.selector);
        market.list(address(nft), 1, 1 ether, uint64(block.timestamp));
        vm.expectRevert(FlizyMarketplace.BadExpiry.selector);
        market.list(address(nft), 1, 1 ether, uint64(block.timestamp + 181 days));
        vm.stopPrank();
    }

    function testListRejectsNonERC721() public {
        vm.prank(seller);
        vm.expectRevert(FlizyMarketplace.NotERC721.selector);
        market.list(address(0x1234), 1, 1 ether, expiry);
    }

    function testListWhenPausedReverts() public {
        market.setPaused(true);
        vm.prank(seller);
        vm.expectRevert(FlizyMarketplace.Paused.selector);
        market.list(address(nft), 1, 1 ether, expiry);
    }

    // ------------------------------------------------------------ cancelListing

    function testSellerCancels() public {
        _list(1, 1 ether);
        vm.prank(seller);
        market.cancelListing(address(nft), 1);
        assertEq(market.getListing(address(nft), 1).seller, address(0));
    }

    function testNewOwnerClearsStaleListing() public {
        _list(1, 1 ether);
        vm.prank(seller);
        nft.transferFrom(seller, buyer, 1);
        assertFalse(market.isListingValid(address(nft), 1));
        vm.prank(buyer);
        market.cancelListing(address(nft), 1);
        assertEq(market.getListing(address(nft), 1).seller, address(0));
    }

    function testStrangerCannotCancel() public {
        _list(1, 1 ether);
        vm.prank(buyer);
        vm.expectRevert(FlizyMarketplace.NotCancellable.selector);
        market.cancelListing(address(nft), 1);
    }

    function testCancelMissingListingReverts() public {
        vm.expectRevert(FlizyMarketplace.NotListed.selector);
        market.cancelListing(address(nft), 1);
    }

    function testCancelWorksWhenPaused() public {
        _list(1, 1 ether);
        market.setPaused(true);
        vm.prank(seller);
        market.cancelListing(address(nft), 1);
    }

    // --------------------------------------------------------------------- buy

    function testBuyPaysFeeAndSeller() public {
        _list(1, 1 ether);
        vm.prank(buyer);
        market.buy{value: 1 ether}(address(nft), 1, 1 ether);
        assertEq(nft.ownerOf(1), buyer);
        assertEq(fees.balance, 0.02 ether);
        assertEq(seller.balance, 0.98 ether);
        assertEq(address(market).balance, 0);
        assertEq(market.getListing(address(nft), 1).seller, address(0));
    }

    function testBuyPaysExplicitRoyalty() public {
        market.setRoyalty(address(nft), creator, 500); // test contract deployed nft, so it is owner()
        _list(1, 1 ether);
        vm.prank(buyer);
        market.buy{value: 1 ether}(address(nft), 1, 1 ether);
        assertEq(fees.balance, 0.02 ether);
        assertEq(creator.balance, 0.05 ether);
        assertEq(seller.balance, 0.93 ether);
    }

    function testOneWeiSaleLeavesNothingInContract() public {
        // 1 wei sale: fee and royalty round down to 0, seller gets the wei.
        market.setRoyalty(address(nft), creator, 1000);
        _list(1, 1);
        vm.prank(buyer);
        market.buy{value: 1}(address(nft), 1, 1);
        assertEq(seller.balance + fees.balance + creator.balance, 1);
        assertEq(address(market).balance, 0);
    }

    function testBuyRejectsWrongValue() public {
        _list(1, 1 ether);
        vm.prank(buyer);
        vm.expectRevert(FlizyMarketplace.PriceChanged.selector);
        market.buy{value: 0.5 ether}(address(nft), 1, 1 ether);
    }

    function testBuyRejectsChangedPrice() public {
        _list(1, 1 ether);
        _list(1, 2 ether); // seller raises the price under a pending buy
        vm.prank(buyer);
        vm.expectRevert(FlizyMarketplace.PriceChanged.selector);
        market.buy{value: 1 ether}(address(nft), 1, 1 ether);
    }

    function testBuyRejectsExpired() public {
        _list(1, 1 ether);
        vm.warp(expiry + 1);
        vm.prank(buyer);
        vm.expectRevert(FlizyMarketplace.ListingExpired.selector);
        market.buy{value: 1 ether}(address(nft), 1, 1 ether);
    }

    function testBuyRejectsStaleListing() public {
        _list(1, 1 ether);
        vm.prank(seller);
        nft.transferFrom(seller, creator, 1);
        vm.prank(buyer);
        vm.expectRevert(FlizyMarketplace.StaleListing.selector);
        market.buy{value: 1 ether}(address(nft), 1, 1 ether);
    }

    function testBuyRevokedApprovalReverts() public {
        _list(1, 1 ether);
        vm.prank(seller);
        nft.approve(address(0), 1);
        assertFalse(market.isListingValid(address(nft), 1));
        vm.prank(buyer);
        vm.expectRevert(FlizyMarketplace.StaleListing.selector);
        market.buy{value: 1 ether}(address(nft), 1, 1 ether);
    }

    function testListingDoesNotComeBackWhenTheTokenReturns() public {
        _list(1, 1 ether);
        // The seller also holds operator approval, which survives transfers.
        vm.startPrank(seller);
        nft.setApprovalForAll(address(market), true);
        nft.transferFrom(seller, creator, 1);
        vm.stopPrank();
        vm.prank(creator);
        nft.transferFrom(creator, seller, 1);
        assertEq(nft.ownerOf(1), seller);
        assertFalse(market.isListingValid(address(nft), 1));
        vm.prank(buyer);
        vm.expectRevert(FlizyMarketplace.StaleListing.selector);
        market.buy{value: 1 ether}(address(nft), 1, 1 ether);
    }

    function testRoyaltyRaisedAfterListingIsCappedAtTheListedRate() public {
        market.setRoyalty(address(nft), creator, 500);
        _list(1, 1 ether);
        market.setRoyalty(address(nft), creator, 1000);
        vm.prank(buyer);
        market.buy{value: 1 ether}(address(nft), 1, 1 ether);
        assertEq(creator.balance, 0.05 ether);
        assertEq(seller.balance, 0.93 ether);
    }

    function testRoyaltyLoweredAfterListingPaysTheLowerRate() public {
        market.setRoyalty(address(nft), creator, 500);
        _list(1, 1 ether);
        market.setRoyalty(address(nft), creator, 100);
        vm.prank(buyer);
        market.buy{value: 1 ether}(address(nft), 1, 1 ether);
        assertEq(creator.balance, 0.01 ether);
        assertEq(seller.balance, 0.97 ether);
    }

    function testBuyUnlistedReverts() public {
        vm.prank(buyer);
        vm.expectRevert(FlizyMarketplace.NotListed.selector);
        market.buy{value: 1 ether}(address(nft), 1, 1 ether);
    }

    function testSellerCannotBuyOwnListing() public {
        _list(1, 1 ether);
        vm.deal(seller, 1 ether);
        vm.prank(seller);
        vm.expectRevert(FlizyMarketplace.OwnPurchase.selector);
        market.buy{value: 1 ether}(address(nft), 1, 1 ether);
    }

    function testBuyWhenPausedReverts() public {
        _list(1, 1 ether);
        market.setPaused(true);
        vm.prank(buyer);
        vm.expectRevert(FlizyMarketplace.Paused.selector);
        market.buy{value: 1 ether}(address(nft), 1, 1 ether);
    }

    function testReentrantCollectionCannotBuyTwice() public {
        ReentrantNFT bad = new ReentrantNFT();
        bad.mint(seller, 7);
        vm.startPrank(seller);
        bad.approve(address(market), 7);
        market.list(address(bad), 7, 1 ether, expiry);
        vm.stopPrank();
        bad.arm(market, 7);
        vm.prank(buyer);
        vm.expectRevert(FlizyMarketplace.Reentrancy.selector);
        market.buy{value: 1 ether}(address(bad), 7, 1 ether);
    }

    function testCollectionThatDoesNotTransferCannotTakePayment() public {
        FakeTransferNFT fake = new FakeTransferNFT();
        fake.mint(seller, 3);
        vm.startPrank(seller);
        fake.approve(address(market), 3);
        market.list(address(fake), 3, 1 ether, expiry);
        vm.stopPrank();
        vm.prank(buyer);
        vm.expectRevert(FlizyMarketplace.TransferFailed.selector);
        market.buy{value: 1 ether}(address(fake), 3, 1 ether);
    }

    function testRejectingSellerIsCreditedNotBlocking() public {
        Rejector r = new Rejector();
        nft.mint(address(r), 9);
        r.approveOne(nft, address(market), 9);
        r.list(market, address(nft), 9, 1 ether, expiry);
        vm.prank(buyer);
        market.buy{value: 1 ether}(address(nft), 9, 1 ether);
        assertEq(nft.ownerOf(9), buyer);
        assertEq(market.credits(address(r)), 0.98 ether);
        assertEq(address(market).balance, 0.98 ether);
    }

    // ---------------------------------------------------------------- withdraw

    function testWithdrawPaysCredit() public {
        // A seller contract that rejects pushes but accepts a withdraw call.
        FlakyReceiver flaky = new FlakyReceiver();
        nft.mint(address(flaky), 10);
        flaky.approveOne(nft, address(market), 10);
        flaky.list(market, address(nft), 10, 1 ether, expiry);
        vm.prank(buyer);
        market.buy{value: 1 ether}(address(nft), 10, 1 ether);
        assertEq(market.credits(address(flaky)), 0.98 ether);
        flaky.open();
        flaky.claim(market);
        assertEq(address(flaky).balance, 0.98 ether);
        assertEq(market.credits(address(flaky)), 0);
    }

    function testWithdrawNothingReverts() public {
        vm.expectRevert(FlizyMarketplace.NothingToWithdraw.selector);
        market.withdraw();
    }

    function testWithdrawToRejectorReverts() public {
        Rejector r = new Rejector();
        nft.mint(address(r), 9);
        r.approveOne(nft, address(market), 9);
        r.list(market, address(nft), 9, 1 ether, expiry);
        vm.prank(buyer);
        market.buy{value: 1 ether}(address(nft), 9, 1 ether);
        vm.expectRevert(FlizyMarketplace.TransferFailed.selector);
        r.claim(market);
        assertEq(market.credits(address(r)), 0.98 ether);
    }

    // ------------------------------------------------------------------ offers

    function testMakeAndCancelOfferRefunds() public {
        vm.prank(buyer);
        uint256 id = market.makeOffer{value: 1 ether}(address(nft), 1, false, expiry);
        assertEq(address(market).balance, 1 ether);
        vm.prank(buyer);
        market.cancelOffer(id);
        assertEq(buyer.balance, 100 ether);
        assertEq(market.getOffer(id).maker, address(0));
    }

    function testMakeOfferRejectsZeroAndBadInputs() public {
        vm.startPrank(buyer);
        vm.expectRevert(FlizyMarketplace.BadPrice.selector);
        market.makeOffer(address(nft), 1, false, expiry);
        vm.expectRevert(FlizyMarketplace.BadExpiry.selector);
        market.makeOffer{value: 1}(address(nft), 1, false, uint64(block.timestamp));
        vm.expectRevert(FlizyMarketplace.NotERC721.selector);
        market.makeOffer{value: 1}(address(0x1234), 1, false, expiry);
        vm.stopPrank();
    }

    function testOnlyMakerCancelsOffer() public {
        vm.prank(buyer);
        uint256 id = market.makeOffer{value: 1 ether}(address(nft), 1, false, expiry);
        vm.prank(seller);
        vm.expectRevert(FlizyMarketplace.NotOfferMaker.selector);
        market.cancelOffer(id);
        vm.expectRevert(FlizyMarketplace.NoOffer.selector);
        market.cancelOffer(999);
    }

    function testExpiredOfferStillRefundsAndPauseDoesNotTrapFunds() public {
        vm.prank(buyer);
        uint256 id = market.makeOffer{value: 1 ether}(address(nft), 1, false, expiry);
        vm.warp(expiry + 1);
        market.setPaused(true);
        vm.prank(buyer);
        market.cancelOffer(id);
        assertEq(buyer.balance, 100 ether);
    }

    function testAcceptTokenOffer() public {
        vm.prank(buyer);
        uint256 id = market.makeOffer{value: 1 ether}(address(nft), 1, false, expiry);
        vm.prank(seller);
        market.acceptOffer(id, 1, 1 ether, 1000);
        assertEq(nft.ownerOf(1), buyer);
        assertEq(seller.balance, 0.98 ether);
        assertEq(fees.balance, 0.02 ether);
        assertEq(address(market).balance, 0);
    }

    function testAcceptCollectionOfferWithAnyToken() public {
        vm.prank(buyer);
        uint256 id = market.makeOffer{value: 1 ether}(address(nft), 0, true, expiry);
        vm.prank(seller);
        market.acceptOffer(id, 2, 1 ether, 1000);
        assertEq(nft.ownerOf(2), buyer);
    }

    function testAcceptClearsListingOnSameToken() public {
        _list(1, 5 ether);
        vm.prank(buyer);
        uint256 id = market.makeOffer{value: 1 ether}(address(nft), 1, false, expiry);
        vm.prank(seller);
        market.acceptOffer(id, 1, 1 ether, 1000);
        assertEq(market.getListing(address(nft), 1).seller, address(0));
    }

    function testAcceptRejections() public {
        vm.prank(buyer);
        uint256 id = market.makeOffer{value: 1 ether}(address(nft), 1, false, expiry);

        vm.prank(seller);
        vm.expectRevert(FlizyMarketplace.WrongToken.selector);
        market.acceptOffer(id, 2, 1 ether, 1000);

        vm.prank(seller);
        vm.expectRevert(FlizyMarketplace.AmountChanged.selector);
        market.acceptOffer(id, 1, 2 ether, 1000);

        vm.prank(creator);
        vm.expectRevert(FlizyMarketplace.NotTokenOwner.selector);
        market.acceptOffer(id, 1, 1 ether, 1000);

        vm.expectRevert(FlizyMarketplace.NoOffer.selector);
        market.acceptOffer(999, 1, 1 ether, 1000);

        vm.warp(expiry + 1);
        vm.prank(seller);
        vm.expectRevert(FlizyMarketplace.OfferExpired.selector);
        market.acceptOffer(id, 1, 1 ether, 1000);
    }

    function testAcceptRejectsRoyaltyAboveWhatTheSellerReviewed() public {
        market.setRoyalty(address(nft), creator, 500);
        vm.prank(buyer);
        uint256 id = market.makeOffer{value: 1 ether}(address(nft), 1, false, expiry);
        vm.prank(seller);
        vm.expectRevert(FlizyMarketplace.RoyaltyRaised.selector);
        market.acceptOffer(id, 1, 1 ether, 300);
        vm.prank(seller);
        market.acceptOffer(id, 1, 1 ether, 500);
        assertEq(creator.balance, 0.05 ether);
    }

    function testMakerCannotAcceptOwnOffer() public {
        vm.deal(seller, 1 ether);
        vm.prank(seller);
        uint256 id = market.makeOffer{value: 1 ether}(address(nft), 1, false, expiry);
        vm.prank(seller);
        vm.expectRevert(FlizyMarketplace.OwnPurchase.selector);
        market.acceptOffer(id, 1, 1 ether, 1000);
    }

    function testAcceptWhenPausedReverts() public {
        vm.prank(buyer);
        uint256 id = market.makeOffer{value: 1 ether}(address(nft), 1, false, expiry);
        market.setPaused(true);
        vm.prank(seller);
        vm.expectRevert(FlizyMarketplace.Paused.selector);
        market.acceptOffer(id, 1, 1 ether, 1000);
    }

    // --------------------------------------------------------------- royalties

    function testOnlyCollectionOwnerSetsRoyalty() public {
        vm.prank(buyer);
        vm.expectRevert(FlizyMarketplace.NotCollectionOwner.selector);
        market.setRoyalty(address(nft), buyer, 500);
    }

    function testRoyaltyCappedAtTenPercent() public {
        vm.expectRevert(FlizyMarketplace.RoyaltyTooHigh.selector);
        market.setRoyalty(address(nft), creator, 1001);
        market.setRoyalty(address(nft), creator, 1000);
        (address to, uint256 amount) = market.royaltyFor(address(nft), 1, 1 ether);
        assertEq(to, creator);
        assertEq(amount, 0.1 ether);
    }

    function testRoyaltyNeedsReceiver() public {
        vm.expectRevert(FlizyMarketplace.ZeroAddress.selector);
        market.setRoyalty(address(nft), address(0), 100);
    }

    function testOwnerlessCollectionCannotSetRoyalty() public {
        OwnerlessNFT o = new OwnerlessNFT();
        vm.expectRevert(FlizyMarketplace.NotCollectionOwner.selector);
        market.setRoyalty(address(o), creator, 100);
    }

    function testErc2981FallbackAndCap() public {
        Mock2981NFT r = new Mock2981NFT();
        r.setRoyalty(creator, 2500); // 25%, above the cap
        (address to, uint256 amount) = market.royaltyFor(address(r), 1, 1 ether);
        assertEq(to, creator);
        assertEq(amount, 0.1 ether);

        r.setRoyalty(creator, 300);
        (, amount) = market.royaltyFor(address(r), 1, 1 ether);
        assertEq(amount, 0.03 ether);
    }

    function testExplicitZeroOverridesErc2981() public {
        Mock2981NFT r = new Mock2981NFT();
        r.setRoyalty(creator, 300);
        market.setRoyalty(address(r), address(0), 0);
        (address to, uint256 amount) = market.royaltyFor(address(r), 1, 1 ether);
        assertEq(to, address(0));
        assertEq(amount, 0);
        (, uint256 bps, bool set) = market.royaltySetting(address(r));
        assertEq(bps, 0);
        assertTrue(set);
    }

    function testRevertingRoyaltyInfoPaysNoRoyalty() public {
        Broken2981NFT b = new Broken2981NFT();
        (address to, uint256 amount) = market.royaltyFor(address(b), 1, 1 ether);
        assertEq(to, address(0));
        assertEq(amount, 0);
    }

    function testCollectionWithoutIntrospectionIsNotERC721() public {
        NoIntrospection n = new NoIntrospection();
        vm.prank(seller);
        vm.expectRevert(FlizyMarketplace.NotERC721.selector);
        market.list(address(n), 1, 1 ether, expiry);
    }

    function testRevertingApprovalReadsAsNotApproved() public {
        RevertingApprovalNFT r = new RevertingApprovalNFT();
        r.mint(seller, 1);
        vm.prank(seller);
        vm.expectRevert(FlizyMarketplace.NotApproved.selector);
        market.list(address(r), 1, 1 ether, expiry);
    }

    function testBurnedTokenListingIsInvalid() public {
        _list(1, 1 ether);
        nft.burn(1);
        assertFalse(market.isListingValid(address(nft), 1));
        vm.prank(buyer);
        vm.expectRevert(FlizyMarketplace.StaleListing.selector);
        market.buy{value: 1 ether}(address(nft), 1, 1 ether);
    }

    function testExpiredListingIsInvalid() public {
        _list(1, 1 ether);
        vm.warp(expiry + 1);
        assertFalse(market.isListingValid(address(nft), 1));
    }

    function testNoRoyaltyWithoutSettingOr2981() public view {
        (address to, uint256 amount) = market.royaltyFor(address(nft), 1, 1 ether);
        assertEq(to, address(0));
        assertEq(amount, 0);
    }

    // ------------------------------------------------------------------- admin

    function testAdminFunctionsAreOwnerOnly() public {
        vm.startPrank(buyer);
        vm.expectRevert(FlizyMarketplace.NotOwner.selector);
        market.setPaused(true);
        vm.expectRevert(FlizyMarketplace.NotOwner.selector);
        market.setFeeRecipient(buyer);
        vm.expectRevert(FlizyMarketplace.NotOwner.selector);
        market.transferOwnership(buyer);
        vm.stopPrank();
    }

    function testFeeRecipientUpdateAndZeroGuard() public {
        vm.expectRevert(FlizyMarketplace.ZeroAddress.selector);
        market.setFeeRecipient(address(0));
        market.setFeeRecipient(creator);
        assertEq(market.feeRecipient(), creator);
    }

    function testTwoStepOwnership() public {
        market.transferOwnership(buyer);
        assertEq(market.owner(), address(this));
        vm.prank(seller);
        vm.expectRevert(FlizyMarketplace.NotOwner.selector);
        market.acceptOwnership();
        vm.prank(buyer);
        market.acceptOwnership();
        assertEq(market.owner(), buyer);
        assertEq(market.pendingOwner(), address(0));
    }

    function testUnpause() public {
        market.setPaused(true);
        market.setPaused(false);
        _list(1, 1 ether);
    }

    function testDirectEthIsRejected() public {
        vm.prank(buyer);
        (bool ok,) = address(market).call{value: 1 ether}("");
        assertFalse(ok);
    }
}

/// Rejects ETH until opened, then accepts it.
contract FlakyReceiver {
    bool public accepting;

    function open() external {
        accepting = true;
    }

    function approveOne(MockNFT nft, address op, uint256 id) external {
        nft.approve(op, id);
    }

    function list(FlizyMarketplace m, address c, uint256 id, uint256 price, uint64 expiry) external {
        m.list(c, id, price, expiry);
    }

    function claim(FlizyMarketplace m) external {
        m.withdraw();
    }

    receive() external payable {
        require(accepting, "closed");
    }
}
