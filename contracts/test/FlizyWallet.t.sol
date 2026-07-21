// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {FlizyWallet} from "../src/FlizyWallet.sol";
import {FlizyWalletFactory} from "../src/FlizyWalletFactory.sol";

contract FlizyWalletTest is Test {
    FlizyWallet internal wallet;
    address internal owner = address(0xA11CE);
    address internal session = address(0xB0B);
    address internal stranger = address(0xBAD);
    address internal friend = address(0xF00D);

    function setUp() public {
        wallet = new FlizyWallet(owner, session);
        vm.deal(address(wallet), 10 ether);
        vm.prank(owner);
        wallet.setTrusted(friend, true);
    }

    function testSessionCannotSendToStranger() public {
        vm.prank(session);
        vm.expectRevert(FlizyWallet.NotTrusted.selector);
        wallet.transferNative(stranger, 1 ether);
    }

    function testSessionCanSendToTrusted() public {
        vm.prank(session);
        wallet.transferNative(friend, 1 ether);
        assertEq(friend.balance, 1 ether);
    }

    function testOwnerCanSendAnywhere() public {
        vm.prank(owner);
        wallet.transferNative(stranger, 1 ether);
        assertEq(stranger.balance, 1 ether);
    }

    function testFactoryCreate2Stable() public {
        FlizyWalletFactory factory = new FlizyWalletFactory();
        bytes32 salt = keccak256("account-1");
        address predicted = factory.computeAddress(salt, owner, session);
        address deployed = factory.deploy(salt, owner, session);
        assertEq(predicted, deployed);
    }
}
