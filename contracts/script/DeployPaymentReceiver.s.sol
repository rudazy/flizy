// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Script.sol";
import "../src/pay/FlizyPaymentReceiver.sol";

/// @notice Deploy FlizyPaymentReceiver on GIWA Sepolia. One transaction, no
/// constructor arguments, no owner: nothing is configured after deploy.
contract DeployPaymentReceiver is Script {
    uint256 constant GIWA_SEPOLIA = 91342;

    function run() external {
        require(block.chainid == GIWA_SEPOLIA, "wrong chain");
        uint256 pk = vm.envUint("PRIVATE_KEY");

        vm.startBroadcast(pk);
        FlizyPaymentReceiver receiver = new FlizyPaymentReceiver();
        vm.stopBroadcast();

        console2.log("PAYMENT_RECEIVER", address(receiver));
    }
}
