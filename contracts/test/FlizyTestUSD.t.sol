// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {FlizyTestUSD} from "../src/dex/FlizyTestUSD.sol";

/**
 * FlizyTestUSD backs tUSD. Every state-changing path is covered: the one-time
 * mint in the constructor, approve, transfer and transferFrom with a finite
 * and an unlimited allowance, and each revert.
 */
contract FlizyTestUSDTest is Test {
    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    /// One tUSD in base units.
    uint256 constant USD = 1e6;
    uint256 constant SUPPLY = 1_000_000_000 * USD;

    address holder = makeAddr("holder");
    address alice = makeAddr("alice");
    address spender = makeAddr("spender");

    FlizyTestUSD token;

    function setUp() public {
        token = new FlizyTestUSD(SUPPLY, holder);
    }

    function test_constructor_setsMetadataAndMintsSupplyOnce() public view {
        assertEq(token.name(), "Flizy Test USD");
        assertEq(token.symbol(), "tUSD");
        assertEq(token.decimals(), 6);
        assertEq(token.totalSupply(), SUPPLY);
        assertEq(token.balanceOf(holder), SUPPLY);
    }

    function test_constructor_emitsMintTransfer() public {
        vm.expectEmit(true, true, false, true);
        emit Transfer(address(0), alice, 5 * USD);
        new FlizyTestUSD(5 * USD, alice);
    }

    function test_constructor_refusesZeroRecipient() public {
        vm.expectRevert(bytes("TUSD: zero mint"));
        new FlizyTestUSD(SUPPLY, address(0));
    }

    function test_transfer_movesBalance() public {
        vm.expectEmit(true, true, false, true);
        emit Transfer(holder, alice, 10 * USD);
        vm.prank(holder);
        assertTrue(token.transfer(alice, 10 * USD));
        assertEq(token.balanceOf(alice), 10 * USD);
        assertEq(token.balanceOf(holder), SUPPLY - 10 * USD);
        assertEq(token.totalSupply(), SUPPLY);
    }

    function test_transfer_refusesOverBalance() public {
        vm.prank(alice);
        vm.expectRevert(bytes("TUSD: balance"));
        token.transfer(holder, 1);
    }

    function test_transfer_refusesZeroRecipient() public {
        vm.prank(holder);
        vm.expectRevert(bytes("TUSD: zero to"));
        token.transfer(address(0), 1);
    }

    function test_approve_setsAllowance() public {
        vm.expectEmit(true, true, false, true);
        emit Approval(holder, spender, 7 * USD);
        vm.prank(holder);
        assertTrue(token.approve(spender, 7 * USD));
        assertEq(token.allowance(holder, spender), 7 * USD);
    }

    function test_transferFrom_spendsFiniteAllowance() public {
        vm.prank(holder);
        token.approve(spender, 7 * USD);
        vm.prank(spender);
        assertTrue(token.transferFrom(holder, alice, 3 * USD));
        assertEq(token.allowance(holder, spender), 4 * USD);
        assertEq(token.balanceOf(alice), 3 * USD);
    }

    function test_transferFrom_keepsUnlimitedAllowance() public {
        vm.prank(holder);
        token.approve(spender, type(uint256).max);
        vm.prank(spender);
        token.transferFrom(holder, alice, 3 * USD);
        assertEq(token.allowance(holder, spender), type(uint256).max);
    }

    function test_transferFrom_refusesOverAllowance() public {
        vm.prank(holder);
        token.approve(spender, 1 * USD);
        vm.prank(spender);
        vm.expectRevert(bytes("TUSD: allowance"));
        token.transferFrom(holder, alice, 2 * USD);
    }

    function test_transferFrom_refusesOverBalance() public {
        vm.prank(alice);
        token.approve(spender, type(uint256).max);
        vm.prank(spender);
        vm.expectRevert(bytes("TUSD: balance"));
        token.transferFrom(alice, holder, 1);
    }

    function testFuzz_transfer_conservesSupply(uint256 amount) public {
        amount = bound(amount, 0, SUPPLY);
        vm.prank(holder);
        token.transfer(alice, amount);
        assertEq(token.balanceOf(holder) + token.balanceOf(alice), SUPPLY);
    }
}
