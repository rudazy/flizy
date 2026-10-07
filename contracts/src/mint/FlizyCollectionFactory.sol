// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {FlizyCollection} from "./FlizyCollection.sol";
import {FlizyLayeredCollection} from "./FlizyLayeredCollection.sol";

/**
 * @title FlizyCollectionFactory
 * @notice Deploys Flizy-native collections. The caller becomes the collection
 * owner and royalty receiver; the FlizyDrop fixed here is its only minter.
 * create makes a single-image collection; createWithMetadata makes one whose
 * tokens each have their own metadata under a fixed base URI.
 * CollectionCreated is the index of every native collection, both kinds.
 */
contract FlizyCollectionFactory {
    address public immutable drop;

    /// @notice True for every collection this factory deployed.
    mapping(address => bool) public isFlizyCollection;

    event CollectionCreated(
        address indexed collection,
        address indexed creator,
        string name,
        string symbol,
        uint256 maxSupply,
        uint96 royaltyBps
    );

    error ZeroAddress();

    constructor(address drop_) {
        if (drop_ == address(0)) revert ZeroAddress();
        drop = drop_;
    }

    function create(
        string calldata name,
        string calldata symbol,
        uint256 maxSupply,
        string calldata image,
        uint96 royaltyBps
    ) external returns (address collection) {
        collection = address(
            new FlizyCollection(name, symbol, maxSupply, image, msg.sender, drop, msg.sender, royaltyBps)
        );
        isFlizyCollection[collection] = true;
        emit CollectionCreated(collection, msg.sender, name, symbol, maxSupply, royaltyBps);
    }

    /// @notice A collection whose token metadata is baseURI + id + ".json"; image is its cover.
    function createWithMetadata(
        string memory name,
        string memory symbol,
        uint256 maxSupply,
        string memory image,
        string memory baseURI,
        uint96 royaltyBps
    ) external returns (address collection) {
        collection = address(
            new FlizyLayeredCollection(name, symbol, maxSupply, image, baseURI, msg.sender, drop, msg.sender, royaltyBps)
        );
        isFlizyCollection[collection] = true;
        emit CollectionCreated(collection, msg.sender, name, symbol, maxSupply, royaltyBps);
    }
}
