// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Script.sol";
import "../src/dex/WETH9.sol";
import "../src/dex/FLZ.sol";
import "../src/dex/UniswapV2Factory.sol";
import "../src/dex/UniswapV2Router02.sol";
import "../src/dex/UniswapV2Pair.sol";
import "../src/dex/FlizyFeeRouter.sol";

/// @notice Deploy Flizy DEX stack on GIWA Sepolia and seed FLZ/WETH liquidity.
contract DeployDex is Script {
    // 100_000 FLZ
    uint256 constant FLZ_SUPPLY = 100_000 ether;
    // Seed: 60_000 FLZ + 1.2 ETH (leave room for gas)
    uint256 constant SEED_FLZ = 60_000 ether;
    uint256 constant SEED_ETH = 1.2 ether;
    uint16 constant DEFAULT_FEE_BPS = 30;

    function run() external {
        address treasury = vm.envOr("FLIZY_TREASURY", msg.sender);
        uint256 pk = vm.envUint("PRIVATE_KEY");
        address deployer = vm.addr(pk);

        vm.startBroadcast(pk);

        WETH9 weth = new WETH9();
        FLZ flz = new FLZ(FLZ_SUPPLY, deployer);

        UniswapV2Factory factory = new UniswapV2Factory(deployer);
        factory.setFeeTo(treasury);

        bytes32 pairCodeHash = keccak256(type(UniswapV2Pair).creationCode);
        UniswapV2Router02 router = new UniswapV2Router02(address(factory), address(weth), pairCodeHash);
        FlizyFeeRouter feeRouter = new FlizyFeeRouter(address(router), treasury, DEFAULT_FEE_BPS);

        // Approve + seed liquidity via V2 router (no fee on seed)
        require(flz.approve(address(router), SEED_FLZ), "approve");
        router.addLiquidityETH{value: SEED_ETH}(
            address(flz),
            SEED_FLZ,
            SEED_FLZ,
            SEED_ETH,
            deployer,
            block.timestamp + 1 hours
        );

        address pair = factory.getPair(address(flz), address(weth));

        vm.stopBroadcast();

        console2.log("WETH", address(weth));
        console2.log("FLZ", address(flz));
        console2.log("FACTORY", address(factory));
        console2.log("ROUTER", address(router));
        console2.log("FEE_ROUTER", address(feeRouter));
        console2.log("PAIR", pair);
        console2.log("PAIR_CODE_HASH");
        console2.logBytes32(pairCodeHash);
        console2.log("TREASURY", treasury);
        console2.log("SEED_ETH_wei", SEED_ETH);
        console2.log("SEED_FLZ_wei", SEED_FLZ);
    }
}
