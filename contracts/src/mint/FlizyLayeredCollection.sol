// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {FlizyCollection} from "./FlizyCollection.sol";

/**
 * @title FlizyLayeredCollection
 * @notice A FlizyCollection whose tokens each have their own metadata: art and
 * traits generated per token and stored off chain. tokenURI is
 * baseURI + tokenId + ".json". The base URI is fixed at deploy and has no
 * setter, so the metadata a collector minted against cannot be swapped later.
 * `image` stays the collection's cover. Minting, royalty and ownership are
 * FlizyCollection's, unchanged.
 */
contract FlizyLayeredCollection is FlizyCollection {
    /// @notice ipfs:// or https:// folder holding <id>.json for every token, ending in "/".
    string public baseURI;

    error BadBaseURI();

    constructor(
        string memory name_,
        string memory symbol_,
        uint256 maxSupply_,
        string memory image_,
        string memory baseURI_,
        address owner_,
        address minter_,
        address royaltyReceiver_,
        uint96 royaltyBps_
    ) FlizyCollection(name_, symbol_, maxSupply_, image_, owner_, minter_, royaltyReceiver_, royaltyBps_) {
        bytes memory b = bytes(baseURI_);
        if (!_safeImage(b) || b[b.length - 1] != "/") revert BadBaseURI();
        baseURI = baseURI_;
    }

    /// @notice baseURI + tokenId + ".json". Reverts for a token that does not exist.
    function tokenURI(uint256 tokenId) external view override returns (string memory) {
        ownerOf(tokenId);
        return string(abi.encodePacked(baseURI, _toString(tokenId), ".json"));
    }
}
