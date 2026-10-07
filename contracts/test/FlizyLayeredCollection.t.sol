// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {FlizyCollection} from "../src/mint/FlizyCollection.sol";
import {FlizyLayeredCollection} from "../src/mint/FlizyLayeredCollection.sol";
import {FlizyCollectionFactory} from "../src/mint/FlizyCollectionFactory.sol";
import {FlizyDrop} from "../src/mint/FlizyDrop.sol";

contract FlizyLayeredCollectionTest is Test {
    address internal creator = makeAddr("creator");
    address internal minter = makeAddr("minter");
    address internal alice = makeAddr("alice");

    string internal constant COVER = "ipfs://bafycover/cover.png";
    string internal constant BASE = "ipfs://bafymeta/";

    function _deploy(string memory base) internal returns (FlizyLayeredCollection) {
        return new FlizyLayeredCollection("Cyber Frogs", "CFROG", 100, COVER, base, creator, minter, creator, 500);
    }

    function test_tokenURI_is_base_plus_id_json() public {
        FlizyLayeredCollection c = _deploy(BASE);
        vm.prank(minter);
        c.mintTo(alice, 12);
        assertEq(c.tokenURI(1), "ipfs://bafymeta/1.json");
        assertEq(c.tokenURI(12), "ipfs://bafymeta/12.json");
        assertEq(c.baseURI(), BASE);
        assertEq(c.image(), COVER);
    }

    function test_tokenURI_reverts_for_missing_token() public {
        FlizyLayeredCollection c = _deploy(BASE);
        vm.expectRevert(FlizyCollection.NotTokenOwner.selector);
        c.tokenURI(1);
    }

    function test_https_base_is_allowed() public {
        FlizyLayeredCollection c = _deploy("https://meta.example/frogs/");
        vm.prank(minter);
        c.mintTo(alice, 1);
        assertEq(c.tokenURI(1), "https://meta.example/frogs/1.json");
    }

    function test_rejects_a_bad_base_uri() public {
        string[6] memory bad = [
            "ipfs://bafymeta",          // no trailing slash
            "http://meta.example/",     // not https
            "ftp://meta.example/",
            "ipfs://bad meta/",         // space
            'ipfs://a"b/',              // quote
            ""
        ];
        for (uint256 i = 0; i < bad.length; i++) {
            vm.expectRevert(FlizyLayeredCollection.BadBaseURI.selector);
            _deploy(bad[i]);
        }
    }

    function test_keeps_collection_rules() public {
        FlizyLayeredCollection c = _deploy(BASE);
        assertEq(c.maxSupply(), 100);
        assertEq(c.royaltyBps(), 500);
        vm.prank(alice);
        vm.expectRevert(FlizyCollection.NotMinter.selector);
        c.mintTo(alice, 1);
    }

    function test_factory_creates_with_metadata_and_indexes_it() public {
        FlizyCollectionFactory factory = new FlizyCollectionFactory(minter);
        vm.prank(creator);
        address made = factory.createWithMetadata("Cyber Frogs", "CFROG", 50, COVER, BASE, 250);
        FlizyLayeredCollection x = FlizyLayeredCollection(made);
        assertTrue(factory.isFlizyCollection(made));
        assertEq(x.owner(), creator);
        assertEq(x.flizyMinter(), minter);
        assertEq(x.royaltyBps(), 250);
        assertEq(x.baseURI(), BASE);
        vm.prank(minter);
        x.mintTo(alice, 1);
        assertEq(x.tokenURI(1), "ipfs://bafymeta/1.json");
    }

    function test_mints_through_flizy_drop() public {
        address feeTo = makeAddr("fees");
        FlizyDrop drop = new FlizyDrop(feeTo);
        FlizyCollectionFactory factory = new FlizyCollectionFactory(address(drop));
        vm.prank(creator);
        address made = factory.createWithMetadata("Cyber Frogs", "CFROG", 50, COVER, BASE, 0);
        FlizyDrop.Config memory cfg = FlizyDrop.Config({
            allowlistStart: 0,
            allowlistEnd: 0,
            publicStart: uint64(block.timestamp),
            mintEnd: uint64(block.timestamp + 1 days),
            allowlistPrice: 0,
            publicPrice: 0,
            publicLimit: 5,
            merkleRoot: bytes32(0),
            payout: creator
        });
        vm.prank(creator);
        drop.configure(made, cfg);
        vm.prank(alice);
        drop.mintPublic(made, 2);
        assertEq(FlizyLayeredCollection(made).ownerOf(2), alice);
        assertEq(FlizyLayeredCollection(made).tokenURI(2), "ipfs://bafymeta/2.json");
    }
}
