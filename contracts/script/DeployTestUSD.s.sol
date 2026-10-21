// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Script.sol";
import "../src/dex/FlizyTestUSD.sol";
import "../src/dex/UniswapV2Factory.sol";
import "../src/dex/UniswapV2Router02.sol";

/// @notice Deploy tUSD and seed its WETH pool on the existing Flizy DEX (GIWA
/// Sepolia). The LP tokens and the unseeded supply go to the deployer, which
/// later funds the faucet dispenser from it.
/// @dev The pool must be new: seeding a pool that already has reserves would
/// add at the pool's price, not the one set here, so the script refuses.
contract DeployTestUSD is Script {
    uint256 constant GIWA_SEPOLIA = 91342;

    // Existing Flizy DEX (deployments/giwa-sepolia.json).
    address constant ROUTER = 0x4055413A4757e069bbCAc481639EF2814224Faa0;
    address constant FACTORY = 0xBB1d2c582E455B448660A199097A54DF29162BbF;
    address constant WETH = 0x3a13399f2741122B63c7710B2A85346B97C6BFDf;

    /// One tUSD in base units (six decimals).
    uint256 constant USD = 1e6;
    uint256 constant SUPPLY = 1_000_000_000 * USD;
    // Opens at 4,000 tUSD per ETH. The deployer also pays gas for live
    // handleOps, so the ETH side is kept small.
    uint256 constant SEED_USD = 800 * USD;
    uint256 constant SEED_ETH = 0.2 ether;

    function run() external {
        require(block.chainid == GIWA_SEPOLIA, "wrong chain");
        uint256 pk = vm.envUint("PRIVATE_KEY");
        address deployer = vm.addr(pk);

        vm.startBroadcast(pk);

        FlizyTestUSD tusd = new FlizyTestUSD(SUPPLY, deployer);
        require(UniswapV2Factory(FACTORY).getPair(address(tusd), WETH) == address(0), "pool exists");
        require(tusd.approve(ROUTER, SEED_USD), "approve");
        UniswapV2Router02(payable(ROUTER)).addLiquidityETH{value: SEED_ETH}(
            address(tusd), SEED_USD, SEED_USD, SEED_ETH, deployer, block.timestamp + 1 hours
        );
        address pair = UniswapV2Factory(FACTORY).getPair(address(tusd), WETH);
        require(pair != address(0), "no pair");

        vm.stopBroadcast();

        console2.log("TUSD", address(tusd));
        console2.log("PAIR_TUSD_WETH", pair);
    }
}
