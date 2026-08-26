// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Script.sol";
import "../src/nft/Giwaforge.sol";

contract MintGiwaforge is Script {
    function run(address collection, address to, uint256 count) external {
        uint256 pk = vm.envUint("PRIVATE_KEY");
        vm.startBroadcast(pk);
        Giwaforge(collection).mint(to, count);
        vm.stopBroadcast();
        console2.log("COLLECTION", collection);
        console2.log("TO", to);
        console2.log("COUNT", count);
        console2.log("TOTAL", Giwaforge(collection).totalSupply());
    }
}
