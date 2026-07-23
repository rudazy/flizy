// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Flizy testnet ERC20. Symbol FLZ. Demo asset only (no tax, no vesting).
contract FLZ {
    string public constant name = "Flizy";
    string public constant symbol = "FLZ";
    uint8 public constant decimals = 18;

    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    constructor(uint256 initialSupply, address mintTo) {
        require(mintTo != address(0), "FLZ: zero mint");
        totalSupply = initialSupply;
        balanceOf[mintTo] = initialSupply;
        emit Transfer(address(0), mintTo, initialSupply);
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        emit Approval(msg.sender, spender, amount);
        return true;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        return _transfer(msg.sender, to, amount);
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        uint256 allowed = allowance[from][msg.sender];
        if (allowed != type(uint256).max) {
            require(allowed >= amount, "FLZ: allowance");
            allowance[from][msg.sender] = allowed - amount;
        }
        return _transfer(from, to, amount);
    }

    function _transfer(address from, address to, uint256 amount) internal returns (bool) {
        require(to != address(0), "FLZ: zero to");
        require(balanceOf[from] >= amount, "FLZ: balance");
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        emit Transfer(from, to, amount);
        return true;
    }
}
