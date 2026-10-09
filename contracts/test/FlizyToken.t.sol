// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {FlizyToken} from "../src/dex/FlizyToken.sol";

/**
 * FlizyToken backs IZY and MAKI. Every state-changing path is covered: the
 * one-time mint in the constructor, approve, transfer and transferFrom with a
 * finite and an unlimited allowance, and each revert.
 */
contract FlizyTokenTest is Test {
    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    uint256 constant SUPPLY = 1_000_000 ether;

    address holder = makeAddr("holder");
    address alice = makeAddr("alice");
    address spender = makeAddr("spender");

    FlizyToken token;

    function setUp() public {
        token = new FlizyToken("Izy", "IZY", SUPPLY, holder);
    }

    function test_constructor_setsMetadataAndMintsSupplyOnce() public view {
        assertEq(token.name(), "Izy");
        assertEq(token.symbol(), "IZY");
        assertEq(token.decimals(), 18);
        assertEq(token.totalSupply(), SUPPLY);
        assertEq(token.balanceOf(holder), SUPPLY);
    }

    function test_constructor_emitsMintTransfer() public {
        vm.expectEmit(true, true, false, true);
        emit Transfer(address(0), alice, 5 ether);
        new FlizyToken("Maki", "MAKI", 5 ether, alice);
    }

    function test_constructor_refusesZeroRecipient() public {
        vm.expectRevert(bytes("TOKEN: zero mint"));
        new FlizyToken("Izy", "IZY", SUPPLY, address(0));
    }

    function test_constructor_refusesEmptyNameOrSymbol() public {
        vm.expectRevert(bytes("TOKEN: empty name"));
        new FlizyToken("", "IZY", SUPPLY, holder);
        vm.expectRevert(bytes("TOKEN: empty name"));
        new FlizyToken("Izy", "", SUPPLY, holder);
    }

    function test_transfer_movesBalance() public {
        vm.expectEmit(true, true, false, true);
        emit Transfer(holder, alice, 10 ether);
        vm.prank(holder);
        assertTrue(token.transfer(alice, 10 ether));
        assertEq(token.balanceOf(alice), 10 ether);
        assertEq(token.balanceOf(holder), SUPPLY - 10 ether);
        assertEq(token.totalSupply(), SUPPLY);
    }

    function test_transfer_refusesOverBalance() public {
        vm.prank(alice);
        vm.expectRevert(bytes("TOKEN: balance"));
        token.transfer(holder, 1);
    }

    function test_transfer_refusesZeroRecipient() public {
        vm.prank(holder);
        vm.expectRevert(bytes("TOKEN: zero to"));
        token.transfer(address(0), 1);
    }

    function test_approve_setsAllowance() public {
        vm.expectEmit(true, true, false, true);
        emit Approval(holder, spender, 7 ether);
        vm.prank(holder);
        assertTrue(token.approve(spender, 7 ether));
        assertEq(token.allowance(holder, spender), 7 ether);
    }

    function test_transferFrom_spendsFiniteAllowance() public {
        vm.prank(holder);
        token.approve(spender, 7 ether);
        vm.prank(spender);
        assertTrue(token.transferFrom(holder, alice, 3 ether));
        assertEq(token.allowance(holder, spender), 4 ether);
        assertEq(token.balanceOf(alice), 3 ether);
    }

    function test_transferFrom_keepsUnlimitedAllowance() public {
        vm.prank(holder);
        token.approve(spender, type(uint256).max);
        vm.prank(spender);
        token.transferFrom(holder, alice, 3 ether);
        assertEq(token.allowance(holder, spender), type(uint256).max);
    }

    function test_transferFrom_refusesOverAllowance() public {
        vm.prank(holder);
        token.approve(spender, 1 ether);
        vm.prank(spender);
        vm.expectRevert(bytes("TOKEN: allowance"));
        token.transferFrom(holder, alice, 2 ether);
    }

    function test_transferFrom_refusesOverBalance() public {
        vm.prank(alice);
        token.approve(spender, type(uint256).max);
        vm.prank(spender);
        vm.expectRevert(bytes("TOKEN: balance"));
        token.transferFrom(alice, holder, 1);
    }

    function testFuzz_transfer_conservesSupply(uint256 amount) public {
        amount = bound(amount, 0, SUPPLY);
        vm.prank(holder);
        token.transfer(alice, amount);
        assertEq(token.balanceOf(holder) + token.balanceOf(alice), SUPPLY);
    }
}
