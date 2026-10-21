// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {FlizyPaymentReceiver} from "../src/pay/FlizyPaymentReceiver.sol";
import {FlizyTestUSD} from "../src/dex/FlizyTestUSD.sol";

/// A token that answers transferFrom with false instead of reverting.
contract FalseToken {
    function transferFrom(address, address, uint256) external pure returns (bool) {
        return false;
    }
}

/// A token that returns nothing at all, like some early ERC-20s.
contract SilentToken {
    mapping(address => uint256) public balanceOf;

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }

    function transferFrom(address from, address to, uint256 amount) external {
        require(balanceOf[from] >= amount, "silent: balance");
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
    }
}

/// A payee that refuses ETH.
contract Refuser {
    receive() external payable {
        revert("no");
    }
}

/// A payee that tries to pay again from inside the ETH it receives.
contract Reenterer {
    FlizyPaymentReceiver public receiver;
    uint256 public calls;

    constructor(FlizyPaymentReceiver r) {
        receiver = r;
    }

    receive() external payable {
        calls += 1;
        if (calls == 1) receiver.payNative{value: msg.value}(bytes32("again"), address(this));
    }
}

/**
 * Every path of FlizyPaymentReceiver: native and token payments land on the
 * payee in full with one event, nothing is ever left on the contract, and each
 * refusal reverts the whole payment.
 */
contract FlizyPaymentReceiverTest is Test {
    event PaymentReceived(
        bytes32 indexed invoiceId, address indexed payer, address indexed payee, address token, uint256 amount
    );

    FlizyPaymentReceiver receiver;
    FlizyTestUSD tusd;
    address payer = makeAddr("payer");
    address payee = makeAddr("payee");
    bytes32 constant INVOICE = bytes32("invoice-1");

    function setUp() public {
        receiver = new FlizyPaymentReceiver();
        tusd = new FlizyTestUSD(1_000_000e6, payer);
        vm.deal(payer, 10 ether);
    }

    function test_payNative_forwardsAllAndEmits() public {
        vm.expectEmit(true, true, true, true);
        emit PaymentReceived(INVOICE, payer, payee, address(0), 1 ether);
        vm.prank(payer);
        receiver.payNative{value: 1 ether}(INVOICE, payee);
        assertEq(payee.balance, 1 ether);
        assertEq(address(receiver).balance, 0);
    }

    function test_payNative_refusesZeroPayeeAndZeroAmount() public {
        vm.prank(payer);
        vm.expectRevert(FlizyPaymentReceiver.ZeroPayee.selector);
        receiver.payNative{value: 1 ether}(INVOICE, address(0));
        vm.prank(payer);
        vm.expectRevert(FlizyPaymentReceiver.ZeroAmount.selector);
        receiver.payNative(INVOICE, payee);
    }

    function test_payNative_revertsWholePaymentWhenPayeeRefuses() public {
        Refuser refuser = new Refuser();
        vm.prank(payer);
        vm.expectRevert(FlizyPaymentReceiver.NativeTransferFailed.selector);
        receiver.payNative{value: 1 ether}(INVOICE, address(refuser));
        assertEq(payer.balance, 10 ether);
        assertEq(address(receiver).balance, 0);
    }

    function test_payNative_reentryOnlyRepaysTheSameCaller() public {
        Reenterer re = new Reenterer(receiver);
        vm.prank(payer);
        receiver.payNative{value: 1 ether}(INVOICE, address(re));
        // The payee spent what it received on paying itself again; the
        // contract held nothing at any point and holds nothing now.
        assertEq(address(re).balance, 1 ether);
        assertEq(address(receiver).balance, 0);
        assertEq(re.calls(), 2);
    }

    function test_payToken_movesFromPayerToPayeeAndEmits() public {
        vm.prank(payer);
        tusd.approve(address(receiver), 50e6);
        vm.expectEmit(true, true, true, true);
        emit PaymentReceived(INVOICE, payer, payee, address(tusd), 50e6);
        vm.prank(payer);
        receiver.payToken(INVOICE, address(tusd), payee, 50e6);
        assertEq(tusd.balanceOf(payee), 50e6);
        assertEq(tusd.balanceOf(address(receiver)), 0);
        assertEq(tusd.allowance(payer, address(receiver)), 0);
    }

    function test_payToken_cannotSpendSomeoneElsesApproval() public {
        vm.prank(payer);
        tusd.approve(address(receiver), 50e6);
        address thief = makeAddr("thief");
        // The payer is always msg.sender, so an approval only ever pays from its owner.
        vm.prank(thief);
        vm.expectRevert(FlizyPaymentReceiver.TokenTransferFailed.selector);
        receiver.payToken(INVOICE, address(tusd), thief, 50e6);
        assertEq(tusd.balanceOf(payer), 1_000_000e6);
    }

    function test_payToken_refusesWithoutApproval() public {
        vm.prank(payer);
        vm.expectRevert(FlizyPaymentReceiver.TokenTransferFailed.selector);
        receiver.payToken(INVOICE, address(tusd), payee, 1);
    }

    function test_payToken_refusesBadInputs() public {
        vm.startPrank(payer);
        vm.expectRevert(FlizyPaymentReceiver.ZeroPayee.selector);
        receiver.payToken(INVOICE, address(tusd), address(0), 1);
        vm.expectRevert(FlizyPaymentReceiver.ZeroAmount.selector);
        receiver.payToken(INVOICE, address(tusd), payee, 0);
        vm.expectRevert(FlizyPaymentReceiver.NotAToken.selector);
        receiver.payToken(INVOICE, makeAddr("eoa"), payee, 1);
        vm.stopPrank();
    }

    function test_payToken_refusesATokenThatReturnsFalse() public {
        FalseToken bad = new FalseToken();
        vm.prank(payer);
        vm.expectRevert(FlizyPaymentReceiver.TokenTransferFailed.selector);
        receiver.payToken(INVOICE, address(bad), payee, 1);
    }

    function test_payToken_acceptsATokenThatReturnsNothing() public {
        SilentToken silent = new SilentToken();
        silent.mint(payer, 5);
        vm.prank(payer);
        receiver.payToken(INVOICE, address(silent), payee, 5);
        assertEq(silent.balanceOf(payee), 5);
    }

    function test_receive_refusesBareEth() public {
        vm.prank(payer);
        (bool ok,) = address(receiver).call{value: 1 ether}("");
        assertFalse(ok);
        assertEq(address(receiver).balance, 0);
    }

    function testFuzz_payNative_neverKeepsAnything(uint96 amount) public {
        vm.assume(amount > 0);
        vm.deal(payer, amount);
        vm.prank(payer);
        receiver.payNative{value: amount}(INVOICE, payee);
        assertEq(payee.balance, amount);
        assertEq(address(receiver).balance, 0);
    }

    function testFuzz_payToken_neverKeepsAnything(uint64 amount) public {
        vm.assume(amount > 0 && amount <= 1_000_000e6);
        vm.prank(payer);
        tusd.approve(address(receiver), amount);
        vm.prank(payer);
        receiver.payToken(INVOICE, address(tusd), payee, amount);
        assertEq(tusd.balanceOf(payee), amount);
        assertEq(tusd.balanceOf(address(receiver)), 0);
    }
}
