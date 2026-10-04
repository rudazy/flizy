// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @title IFlizyMintable
 * @notice The hook a collection implements so FlizyDrop can run its mint.
 * Flizy-native collections (FlizyCollection) implement it from day one. An
 * existing collection becomes Flizy-managed by implementing it and returning
 * the FlizyDrop address from flizyMinter(). A collection that does not is
 * still mintable through Flizy, but only through its own public mint function,
 * and Flizy then controls none of its rules.
 */
interface IFlizyMintable {
    /// @notice Mint `quantity` new tokens to `to`. Must revert unless called by flizyMinter().
    /// Must revert rather than mint past maxSupply().
    /// @return firstTokenId The id of the first token minted; the rest follow in order.
    function mintTo(address to, uint256 quantity) external returns (uint256 firstTokenId);

    /// @notice The only address allowed to call mintTo.
    function flizyMinter() external view returns (address);

    /// @notice The collection owner (EIP-173). Only this address can configure the drop.
    function owner() external view returns (address);

    function totalSupply() external view returns (uint256);

    function maxSupply() external view returns (uint256);
}
