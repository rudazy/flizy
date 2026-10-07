// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Script.sol";
import "../src/mint/FlizyCollectionFactory.sol";

/// @notice Deploy a new FlizyCollectionFactory wired to the existing FlizyDrop
/// (FLIZY_DROP), so creators can launch generated collections through
/// createWithMetadata. FlizyDrop is not redeployed: its drops, fees and
/// collections stay as they are, and collections made by the previous factory
/// keep working because they name the same drop as their minter. Point
/// CHAIN_GIWA_SEPOLIA_COLLECTION_FACTORY at the new address afterwards.
contract DeployCollectionFactory is Script {
    function run() external {
        uint256 pk = vm.envUint("PRIVATE_KEY");
        address drop = vm.envAddress("FLIZY_DROP");
        require(block.chainid == 91342, "not GIWA Sepolia");
        require(drop.code.length > 0, "FLIZY_DROP has no code");

        vm.startBroadcast(pk);
        FlizyCollectionFactory factory = new FlizyCollectionFactory(drop);
        vm.stopBroadcast();

        console2.log("COLLECTION_FACTORY", address(factory));
        console2.log("DROP", factory.drop());
    }
}
