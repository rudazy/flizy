// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {Giwaforge} from "../src/nft/Giwaforge.sol";

contract GiwaforgeTest is Test {
    Giwaforge internal nft;
    address internal minter = address(this);
    address internal alice = address(0xA11CE);
    address internal bob = address(0xB0B);

    function setUp() public {
        nft = new Giwaforge();
    }

    function testMintOwnerOfAndTransfer() public {
        nft.mint(alice, 3);
        assertEq(nft.totalSupply(), 3);
        assertEq(nft.ownerOf(1), alice);
        assertEq(nft.ownerOf(3), alice);
        assertEq(nft.balanceOf(alice), 3);

        vm.prank(alice);
        nft.transferFrom(alice, bob, 2);
        assertEq(nft.ownerOf(2), bob);
        assertEq(nft.balanceOf(alice), 2);
        assertEq(nft.balanceOf(bob), 1);
    }

    function testOnlyOwnerMints() public {
        vm.prank(alice);
        vm.expectRevert(Giwaforge.NotOwner.selector);
        nft.mint(alice, 1);
    }

    function testCapAndBatch() public {
        for (uint256 i = 0; i < 10; i++) {
            nft.mint(alice, 50);
        }
        assertEq(nft.totalSupply(), 500);
        vm.expectRevert(Giwaforge.Cap.selector);
        nft.mint(alice, 1);
        vm.expectRevert(Giwaforge.BadCount.selector);
        nft.mint(alice, 51);
    }

    function testApproveTransferFrom() public {
        nft.mint(alice, 1);
        vm.prank(alice);
        nft.approve(bob, 1);
        vm.prank(bob);
        nft.transferFrom(alice, bob, 1);
        assertEq(nft.ownerOf(1), bob);
    }

    function testUnknownIdReverts() public {
        vm.expectRevert(Giwaforge.NotTokenOwner.selector);
        nft.ownerOf(1);
    }

    function testPublicClaimOnePerWallet() public {
        vm.prank(alice);
        nft.claim();
        assertEq(nft.ownerOf(1), alice);
        assertEq(nft.claimed(alice), true);
        assertEq(nft.totalSupply(), 1);

        vm.prank(alice);
        vm.expectRevert(Giwaforge.AlreadyClaimed.selector);
        nft.claim();

        vm.prank(bob);
        nft.claim();
        assertEq(nft.ownerOf(2), bob);
    }

    function testOwnerClaimToFrontsGas() public {
        nft.claimTo(alice);
        assertEq(nft.ownerOf(1), alice);
        assertEq(nft.claimed(alice), true);

        vm.prank(bob);
        vm.expectRevert(Giwaforge.NotOwner.selector);
        nft.claimTo(bob);
    }
}
