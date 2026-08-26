// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Script.sol";
import "../src/nft/Giwaforge.sol";

/// @notice Deploy the testnet Giwaforge collection and mint a first batch.
contract DeployGiwaforge is Script {
    uint256 constant FIRST_BATCH = 20;

    function run() external {
        uint256 pk = vm.envUint("PRIVATE_KEY");
        address deployer = vm.addr(pk);
        address mintTo = deployer;
        try vm.envAddress("NFT_MINT_TO") returns (address to) {
            if (to != address(0)) mintTo = to;
        } catch {}

        vm.startBroadcast(pk);
        Giwaforge nft = new Giwaforge();
        nft.mint(mintTo, FIRST_BATCH);
        vm.stopBroadcast();

        console2.log("GIWAFORGE", address(nft));
        console2.log("OWNER", deployer);
        console2.log("MINT_TO", mintTo);
        console2.log("MINTED", FIRST_BATCH);
        console2.log("MAX_SUPPLY", nft.MAX_SUPPLY());
    }
}
