// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Script.sol";
import "../src/nft/Giwaforge.sol";

/// @notice Deploy the testnet Giwaforge collection. Public claim is 1 per wallet.
contract DeployGiwaforge is Script {
    function run() external {
        uint256 pk = vm.envUint("PRIVATE_KEY");
        address deployer = vm.addr(pk);

        vm.startBroadcast(pk);
        Giwaforge nft = new Giwaforge();
        vm.stopBroadcast();

        console2.log("GIWAFORGE", address(nft));
        console2.log("OWNER", deployer);
        console2.log("MAX_SUPPLY", nft.MAX_SUPPLY());
    }
}
