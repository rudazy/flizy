// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Fixed-supply testnet ERC20 for tokens Flizy lists with its own pool.
/// @dev Same transfer rules as FLZ, with the name and symbol set at deploy.
/// The whole supply is minted once in the constructor. There is no owner, no
/// mint, no fee and no pause, so the pool price is the only thing that moves.
contract FlizyToken {
    string public name;
    string public symbol;
    uint8 public constant decimals = 18;

    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    constructor(string memory name_, string memory symbol_, uint256 initialSupply, address mintTo) {
        require(mintTo != address(0), "TOKEN: zero mint");
        require(bytes(name_).length > 0 && bytes(symbol_).length > 0, "TOKEN: empty name");
        name = name_;
        symbol = symbol_;
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
            require(allowed >= amount, "TOKEN: allowance");
            allowance[from][msg.sender] = allowed - amount;
        }
        return _transfer(from, to, amount);
    }

    function _transfer(address from, address to, uint256 amount) internal returns (bool) {
        require(to != address(0), "TOKEN: zero to");
        require(balanceOf[from] >= amount, "TOKEN: balance");
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        emit Transfer(from, to, amount);
        return true;
    }
}
