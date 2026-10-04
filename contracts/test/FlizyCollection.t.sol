// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {FlizyCollection} from "../src/mint/FlizyCollection.sol";
import {FlizyCollectionFactory} from "../src/mint/FlizyCollectionFactory.sol";

contract GoodReceiver {
    function onERC721Received(address, address, uint256, bytes calldata) external pure returns (bytes4) {
        return this.onERC721Received.selector;
    }
}

contract BadReceiver {
    function onERC721Received(address, address, uint256, bytes calldata) external pure returns (bytes4) {
        return 0xdeadbeef;
    }
}

contract NoReceiver {}

contract FlizyCollectionTest is Test {
    address internal creator = makeAddr("creator");
    address internal minter = makeAddr("minter");
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");

    FlizyCollection internal c;

    string internal constant IMAGE = "https://flizy.app/art/frog.png";

    event CollectionCreated(
        address indexed collection,
        address indexed creator,
        string name,
        string symbol,
        uint256 maxSupply,
        uint96 royaltyBps
    );

    function setUp() public {
        c = new FlizyCollection("Franky", "FRANK", 10, IMAGE, creator, minter, creator, 500);
    }

    function _deploy(string memory name, string memory symbol, uint256 supply, string memory image, uint96 bps)
        internal
        returns (FlizyCollection)
    {
        return new FlizyCollection(name, symbol, supply, image, creator, minter, creator, bps);
    }

    // ------------------------------------------------------------ construction

    function test_constructor_sets_fields() public view {
        assertEq(c.name(), "Franky");
        assertEq(c.symbol(), "FRANK");
        assertEq(c.image(), IMAGE);
        assertEq(c.maxSupply(), 10);
        assertEq(c.flizyMinter(), minter);
        assertEq(c.owner(), creator);
        assertEq(c.totalSupply(), 0);
    }

    function test_constructor_rejects_bad_text() public {
        vm.expectRevert(FlizyCollection.BadText.selector);
        _deploy("", "F", 10, IMAGE, 0);
        vm.expectRevert(FlizyCollection.BadText.selector);
        _deploy("Fr\"anky", "F", 10, IMAGE, 0);
        vm.expectRevert(FlizyCollection.BadText.selector);
        _deploy("Fr\\anky", "F", 10, IMAGE, 0);
        vm.expectRevert(FlizyCollection.BadText.selector);
        _deploy("Franky", "SEVENTEEN_CHARS_X", 10, IMAGE, 0);
        vm.expectRevert(FlizyCollection.BadText.selector);
        _deploy(string(abi.encodePacked("a", bytes1(0x0a))), "F", 10, IMAGE, 0);
        vm.expectRevert(FlizyCollection.BadText.selector);
        _deploy(string(abi.encodePacked("caf", bytes1(0xc3), bytes1(0xa9))), "F", 10, IMAGE, 0);
    }

    function test_constructor_rejects_bad_image() public {
        vm.expectRevert(FlizyCollection.BadImage.selector);
        _deploy("A", "A", 10, "http://flizy.app/a.png", 0);
        vm.expectRevert(FlizyCollection.BadImage.selector);
        _deploy("A", "A", 10, "https://flizy.app/a b.png", 0);
        vm.expectRevert(FlizyCollection.BadImage.selector);
        _deploy("A", "A", 10, "https://", 0);
        vm.expectRevert(FlizyCollection.BadImage.selector);
        _deploy("A", "A", 10, "javascript:alert(1)", 0);
        // ipfs is accepted.
        FlizyCollection ok = _deploy("A", "A", 10, "ipfs://bafyexample", 0);
        assertEq(ok.image(), "ipfs://bafyexample");
    }

    function test_constructor_rejects_bad_supply_and_royalty() public {
        vm.expectRevert(FlizyCollection.BadSupply.selector);
        _deploy("A", "A", 0, IMAGE, 0);
        vm.expectRevert(FlizyCollection.BadSupply.selector);
        _deploy("A", "A", 10_001, IMAGE, 0);
        vm.expectRevert(FlizyCollection.RoyaltyTooHigh.selector);
        _deploy("A", "A", 10, IMAGE, 1001);
        _deploy("A", "A", 10_000, IMAGE, 1000);
    }

    function test_constructor_rejects_zero_addresses() public {
        vm.expectRevert(FlizyCollection.ZeroAddress.selector);
        new FlizyCollection("A", "A", 10, IMAGE, address(0), minter, creator, 0);
        vm.expectRevert(FlizyCollection.ZeroAddress.selector);
        new FlizyCollection("A", "A", 10, IMAGE, creator, address(0), creator, 0);
        vm.expectRevert(FlizyCollection.ZeroAddress.selector);
        new FlizyCollection("A", "A", 10, IMAGE, creator, minter, address(0), 100);
        // No royalty: a zero receiver is fine.
        new FlizyCollection("A", "A", 10, IMAGE, creator, minter, address(0), 0);
    }

    // ------------------------------------------------------------------ mint

    function test_mintTo_only_minter() public {
        vm.expectRevert(FlizyCollection.NotMinter.selector);
        vm.prank(creator);
        c.mintTo(alice, 1);
    }

    function test_mintTo_sequential_ids_and_balance() public {
        vm.prank(minter);
        assertEq(c.mintTo(alice, 3), 1);
        vm.prank(minter);
        assertEq(c.mintTo(bob, 2), 4);
        assertEq(c.totalSupply(), 5);
        assertEq(c.balanceOf(alice), 3);
        assertEq(c.ownerOf(3), alice);
        assertEq(c.ownerOf(5), bob);
    }

    function test_mintTo_rejects_bad_input_and_sold_out() public {
        vm.startPrank(minter);
        vm.expectRevert(FlizyCollection.ZeroAddress.selector);
        c.mintTo(address(0), 1);
        vm.expectRevert(FlizyCollection.BadCount.selector);
        c.mintTo(alice, 0);
        vm.expectRevert(FlizyCollection.BadCount.selector);
        c.mintTo(alice, 21);
        c.mintTo(alice, 10);
        vm.expectRevert(FlizyCollection.SoldOut.selector);
        c.mintTo(alice, 1);
        vm.stopPrank();
    }

    // -------------------------------------------------------------- metadata

    function test_tokenURI_is_base64_json() public {
        vm.prank(minter);
        c.mintTo(alice, 10);
        string memory json = string(abi.encodePacked('{"name":"Franky #10","image":"', IMAGE, '"}'));
        assertEq(c.tokenURI(10), string(abi.encodePacked("data:application/json;base64,", vm.toBase64(bytes(json)))));
        string memory one = string(abi.encodePacked('{"name":"Franky #1","image":"', IMAGE, '"}'));
        assertEq(c.tokenURI(1), string(abi.encodePacked("data:application/json;base64,", vm.toBase64(bytes(one)))));
    }

    function test_tokenURI_base64_padding_lengths() public {
        // Names of different lengths exercise all three padding cases.
        string[3] memory names = ["A", "AB", "ABC"];
        for (uint256 i = 0; i < 3; i++) {
            FlizyCollection x = _deploy(names[i], "A", 10, IMAGE, 0);
            vm.prank(minter);
            x.mintTo(alice, 1);
            string memory json = string(abi.encodePacked('{"name":"', names[i], ' #1","image":"', IMAGE, '"}'));
            assertEq(x.tokenURI(1), string(abi.encodePacked("data:application/json;base64,", vm.toBase64(bytes(json)))));
        }
    }

    function test_tokenURI_reverts_for_missing_token() public {
        vm.expectRevert(FlizyCollection.NotTokenOwner.selector);
        c.tokenURI(1);
    }

    function test_supportsInterface() public view {
        assertTrue(c.supportsInterface(0x01ffc9a7));
        assertTrue(c.supportsInterface(0x80ac58cd));
        assertTrue(c.supportsInterface(0x5b5e139f));
        assertTrue(c.supportsInterface(0x2a55205a));
        assertFalse(c.supportsInterface(0xffffffff));
    }

    // -------------------------------------------------------------- transfers

    function _mintOneToAlice() internal {
        vm.prank(minter);
        c.mintTo(alice, 1);
    }

    function test_transfer_by_owner_approved_and_operator() public {
        _mintOneToAlice();
        vm.prank(alice);
        c.transferFrom(alice, bob, 1);
        assertEq(c.ownerOf(1), bob);

        vm.prank(bob);
        c.approve(alice, 1);
        assertEq(c.getApproved(1), alice);
        vm.prank(alice);
        c.transferFrom(bob, alice, 1);
        assertEq(c.getApproved(1), address(0), "approval cleared on transfer");

        vm.prank(alice);
        c.setApprovalForAll(bob, true);
        assertTrue(c.isApprovedForAll(alice, bob));
        vm.prank(bob);
        c.transferFrom(alice, bob, 1);
        assertEq(c.balanceOf(alice), 0);
        assertEq(c.balanceOf(bob), 1);
    }

    function test_transfer_rejections() public {
        _mintOneToAlice();
        vm.expectRevert(FlizyCollection.NotAuthorized.selector);
        vm.prank(bob);
        c.transferFrom(alice, bob, 1);
        vm.expectRevert(FlizyCollection.NotTokenOwner.selector);
        vm.prank(alice);
        c.transferFrom(bob, alice, 1);
        vm.expectRevert(FlizyCollection.ZeroAddress.selector);
        vm.prank(alice);
        c.transferFrom(alice, address(0), 1);
        vm.expectRevert(FlizyCollection.NotAuthorized.selector);
        vm.prank(bob);
        c.approve(bob, 1);
        vm.expectRevert(FlizyCollection.SameAddress.selector);
        vm.prank(alice);
        c.setApprovalForAll(alice, true);
        vm.expectRevert(FlizyCollection.ZeroAddress.selector);
        c.balanceOf(address(0));
        vm.expectRevert(FlizyCollection.NotTokenOwner.selector);
        c.getApproved(99);
    }

    function test_operator_can_approve() public {
        _mintOneToAlice();
        vm.prank(alice);
        c.setApprovalForAll(bob, true);
        vm.prank(bob);
        c.approve(creator, 1);
        assertEq(c.getApproved(1), creator);
    }

    function test_safeTransfer_checks_contract_receivers() public {
        vm.prank(minter);
        c.mintTo(alice, 4);
        GoodReceiver good = new GoodReceiver();
        vm.prank(alice);
        c.safeTransferFrom(alice, address(good), 1);
        assertEq(c.ownerOf(1), address(good));

        vm.prank(alice);
        c.safeTransferFrom(alice, bob, 2, "hello");
        assertEq(c.ownerOf(2), bob);

        address bad = address(new BadReceiver());
        vm.expectRevert(FlizyCollection.UnsafeRecipient.selector);
        vm.prank(alice);
        c.safeTransferFrom(alice, bad, 3);

        address none = address(new NoReceiver());
        vm.expectRevert(FlizyCollection.UnsafeRecipient.selector);
        vm.prank(alice);
        c.safeTransferFrom(alice, none, 4);
    }

    // ---------------------------------------------------------------- royalty

    function test_royaltyInfo_and_setRoyalty() public {
        (address to, uint256 amount) = c.royaltyInfo(1, 1 ether);
        assertEq(to, creator);
        assertEq(amount, 0.05 ether);

        vm.prank(creator);
        c.setRoyalty(bob, 1000);
        (to, amount) = c.royaltyInfo(1, 1 ether);
        assertEq(to, bob);
        assertEq(amount, 0.1 ether);

        vm.prank(creator);
        c.setRoyalty(address(0), 0);
        (, amount) = c.royaltyInfo(1, 1 ether);
        assertEq(amount, 0);
    }

    function test_setRoyalty_rejections() public {
        vm.expectRevert(FlizyCollection.NotOwner.selector);
        vm.prank(alice);
        c.setRoyalty(alice, 100);
        vm.expectRevert(FlizyCollection.RoyaltyTooHigh.selector);
        vm.prank(creator);
        c.setRoyalty(alice, 1001);
        vm.expectRevert(FlizyCollection.ZeroAddress.selector);
        vm.prank(creator);
        c.setRoyalty(address(0), 100);
    }

    // -------------------------------------------------------------- ownership

    function test_two_step_ownership() public {
        vm.expectRevert(FlizyCollection.NotOwner.selector);
        vm.prank(alice);
        c.transferOwnership(alice);

        vm.prank(creator);
        c.transferOwnership(alice);
        assertEq(c.owner(), creator, "unchanged until accepted");
        vm.expectRevert(FlizyCollection.NotOwner.selector);
        vm.prank(bob);
        c.acceptOwnership();
        vm.prank(alice);
        c.acceptOwnership();
        assertEq(c.owner(), alice);
        assertEq(c.pendingOwner(), address(0));
    }

    // ---------------------------------------------------------------- factory

    function test_factory_creates_owned_collection() public {
        FlizyCollectionFactory factory = new FlizyCollectionFactory(minter);
        vm.expectEmit(false, true, false, true);
        emit CollectionCreated(address(0), creator, "Frogs", "FROG", 50, 250);
        vm.prank(creator);
        address made = factory.create("Frogs", "FROG", 50, IMAGE, 250);
        FlizyCollection x = FlizyCollection(made);
        assertTrue(factory.isFlizyCollection(made));
        assertEq(x.owner(), creator);
        assertEq(x.flizyMinter(), minter);
        assertEq(x.royaltyReceiver(), creator);
        assertEq(x.royaltyBps(), 250);
        assertEq(x.maxSupply(), 50);
        assertFalse(factory.isFlizyCollection(address(c)));
    }

    function test_factory_rejects_zero_drop() public {
        vm.expectRevert(FlizyCollectionFactory.ZeroAddress.selector);
        new FlizyCollectionFactory(address(0));
    }
}
