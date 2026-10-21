// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Lets any wallet pay a Flizy account and say which ask it is paying.
/// @dev Non-custodial: every call forwards the whole amount to the payee in the
/// same transaction and keeps nothing. There is no owner, no fee, no pause, no
/// storage and no way to sweep, so there is nothing here to steal or to lock.
/// The event is the receipt Flizy reads; the server checks the emitting address,
/// the payee, the token and the amount before it records anything, so a log
/// from any other contract, or a payment to anyone else, never counts.
contract FlizyPaymentReceiver {
    /// @param invoiceId What is being paid, chosen by the page that asked. Opaque here.
    /// @param token address(0) for native ETH.
    event PaymentReceived(
        bytes32 indexed invoiceId, address indexed payer, address indexed payee, address token, uint256 amount
    );

    error ZeroPayee();
    error ZeroAmount();
    error NotAToken();
    error NativeTransferFailed();
    error TokenTransferFailed();

    /// @notice Pay `payee` the ETH sent with this call.
    function payNative(bytes32 invoiceId, address payee) external payable {
        if (payee == address(0)) revert ZeroPayee();
        if (msg.value == 0) revert ZeroAmount();
        emit PaymentReceived(invoiceId, msg.sender, payee, address(0), msg.value);
        (bool ok,) = payee.call{value: msg.value}("");
        if (!ok) revert NativeTransferFailed();
    }

    /// @notice Pay `payee` `amount` of `token`, straight from the payer, who
    /// must first approve this contract for at least `amount`.
    function payToken(bytes32 invoiceId, address token, address payee, uint256 amount) external {
        if (payee == address(0)) revert ZeroPayee();
        if (amount == 0) revert ZeroAmount();
        if (token.code.length == 0) revert NotAToken();
        emit PaymentReceived(invoiceId, msg.sender, payee, token, amount);
        // Tokens that return nothing are accepted; one that returns false is not.
        (bool ok, bytes memory data) = token.call(abi.encodeWithSelector(0x23b872dd, msg.sender, payee, amount));
        if (!ok || (data.length != 0 && !abi.decode(data, (bool)))) revert TokenTransferFailed();
    }

    /// @dev ETH sent without saying who it is for is refused, not kept.
    receive() external payable {
        revert ZeroPayee();
    }
}
