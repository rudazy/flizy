// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Script.sol";
import "../src/mint/FlizyDrop.sol";
import "../src/mint/FlizyCollectionFactory.sol";

/// @notice Deploy Flizy Mint: FlizyDrop (runs every Flizy-managed mint) and the
/// factory for Flizy-native collections, wired to that drop. The 2% fee on paid
/// mints goes to FLIZY_TREASURY, which must be set: there is no fallback to the
/// deployer. block.number here is the simulation's, so the deploy block is read
/// from the broadcast receipt (broadcast/DeployMint.s.sol/91342/run-latest.json)
/// or the explorer.
contract DeployMint is Script {
    function run() external {
        uint256 pk = vm.envUint("PRIVATE_KEY");
        address treasury = vm.envAddress("FLIZY_TREASURY");
        require(block.chainid == 91342, "not GIWA Sepolia");

        vm.startBroadcast(pk);
        FlizyDrop drop = new FlizyDrop(treasury);
        FlizyCollectionFactory factory = new FlizyCollectionFactory(address(drop));
        vm.stopBroadcast();

        console2.log("DROP", address(drop));
        console2.log("COLLECTION_FACTORY", address(factory));
        console2.log("OWNER", vm.addr(pk));
        console2.log("FEE_RECIPIENT", drop.feeRecipient());
        console2.log("FEE_BPS", drop.FEE_BPS());
    }
}
