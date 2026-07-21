// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {FlizyWallet} from "./FlizyWallet.sol";

/**
 * CREATE2 factory so each account gets the same wallet address on every EVM chain.
 * salt should be keccak256(accountId) or similar stable id.
 */
contract FlizyWalletFactory {
    event WalletDeployed(address indexed wallet, address indexed owner, address sessionKey, bytes32 salt);

    function computeAddress(bytes32 salt, address owner, address sessionKey) public view returns (address) {
        bytes memory bytecode = abi.encodePacked(
            type(FlizyWallet).creationCode,
            abi.encode(owner, sessionKey)
        );
        bytes32 hash = keccak256(
            abi.encodePacked(bytes1(0xff), address(this), salt, keccak256(bytecode))
        );
        return address(uint160(uint256(hash)));
    }

    function deploy(bytes32 salt, address owner, address sessionKey) external returns (address wallet) {
        wallet = address(new FlizyWallet{salt: salt}(owner, sessionKey));
        emit WalletDeployed(wallet, owner, sessionKey, salt);
    }
}
