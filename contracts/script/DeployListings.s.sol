// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Script.sol";
import "../src/dex/FlizyToken.sol";
import "../src/dex/IERC20.sol";
import "../src/dex/UniswapV2Factory.sol";
import "../src/dex/UniswapV2Router02.sol";

/// @notice Deploy IZY and MAKI, then seed WETH pools for DCAT, IZY and MAKI on
/// the existing Flizy DEX (GIWA Sepolia). The LP tokens go to the deployer.
/// @dev Every pool must be new: seeding a pool that already has reserves would
/// add at the pool's price, not the one set here, so the script refuses.
contract DeployListings is Script {
    uint256 constant GIWA_SEPOLIA = 91342;

    // Existing Flizy DEX (deployments/giwa-sepolia.json).
    address constant ROUTER = 0x4055413A4757e069bbCAc481639EF2814224Faa0;
    address constant FACTORY = 0xBB1d2c582E455B448660A199097A54DF29162BbF;
    address constant WETH = 0x3a13399f2741122B63c7710B2A85346B97C6BFDf;

    // DCAT is a third-party token already held by the deployer.
    address constant DCAT = 0x58fB4D3DA82F5d610ad36E6e39e674C17B32Ffd1;
    uint256 constant DCAT_SEED = 230_000 ether;
    // About 827,700 DCAT per ETH, the price of DCAT's other GIWA pool when this
    // pool was seeded, so the two do not open with an arbitrage gap.
    uint256 constant DCAT_SEED_ETH = 0.278 ether;

    uint256 constant NEW_SUPPLY = 1_000_000 ether;
    uint256 constant NEW_SEED = 600_000 ether;
    uint256 constant NEW_SEED_ETH = 1 ether;

    function run() external {
        require(block.chainid == GIWA_SEPOLIA, "wrong chain");
        uint256 pk = vm.envUint("PRIVATE_KEY");
        address deployer = vm.addr(pk);

        vm.startBroadcast(pk);

        FlizyToken izy = new FlizyToken("Izy", "IZY", NEW_SUPPLY, deployer);
        FlizyToken maki = new FlizyToken("Maki", "MAKI", NEW_SUPPLY, deployer);

        address dcatPair = _seed(DCAT, DCAT_SEED, DCAT_SEED_ETH, deployer);
        address izyPair = _seed(address(izy), NEW_SEED, NEW_SEED_ETH, deployer);
        address makiPair = _seed(address(maki), NEW_SEED, NEW_SEED_ETH, deployer);

        vm.stopBroadcast();

        console2.log("IZY", address(izy));
        console2.log("MAKI", address(maki));
        console2.log("PAIR_DCAT_WETH", dcatPair);
        console2.log("PAIR_IZY_WETH", izyPair);
        console2.log("PAIR_MAKI_WETH", makiPair);
    }

    function _seed(address token, uint256 amount, uint256 ethAmount, address to) internal returns (address pair) {
        require(UniswapV2Factory(FACTORY).getPair(token, WETH) == address(0), "pool exists");
        require(IERC20(token).approve(ROUTER, amount), "approve");
        UniswapV2Router02(payable(ROUTER)).addLiquidityETH{value: ethAmount}(
            token, amount, amount, ethAmount, to, block.timestamp + 1 hours
        );
        pair = UniswapV2Factory(FACTORY).getPair(token, WETH);
        require(pair != address(0), "no pair");
    }
}
