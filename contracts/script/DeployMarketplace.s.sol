// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Script.sol";
import "../src/market/FlizyMarketplace.sol";

/// @notice Deploy the NFT marketplace. The 2% sale fee goes to FLIZY_TREASURY,
/// which must be set: there is no fallback to the deployer, so fee income never
/// lands in the ops wallet by accident. block.number here is the simulation's,
/// not the deploy's, so the deploy block is read from the broadcast receipt
/// (broadcast/DeployMarketplace.s.sol/91342/run-latest.json) or the explorer.
contract DeployMarketplace is Script {
    function run() external {
        uint256 pk = vm.envUint("PRIVATE_KEY");
        address treasury = vm.envAddress("FLIZY_TREASURY");
        require(block.chainid == 91342, "not GIWA Sepolia");

        vm.startBroadcast(pk);
        FlizyMarketplace market = new FlizyMarketplace(treasury);
        vm.stopBroadcast();

        console2.log("MARKETPLACE", address(market));
        console2.log("OWNER", vm.addr(pk));
        console2.log("FEE_RECIPIENT", market.feeRecipient());
        console2.log("FEE_BPS", market.FEE_BPS());
    }
}
