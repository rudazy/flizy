// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Flizy Test USD (tUSD): the testnet dollar Flizy payments are priced in.
/// @dev Same transfer rules as FlizyToken, with six decimals so amounts read
/// like a real stablecoin. The whole supply is minted once in the constructor.
/// There is no owner, no mint, no fee and no pause: test dollars reach people
/// through the Flizy faucet, which is funded from that one mint. It is worth
/// nothing and pegs to nothing; its pool price is set by whoever trades it.
contract FlizyTestUSD {
    string public constant name = "Flizy Test USD";
    string public constant symbol = "tUSD";
    uint8 public constant decimals = 6;

    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    constructor(uint256 initialSupply, address mintTo) {
        require(mintTo != address(0), "TUSD: zero mint");
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
            require(allowed >= amount, "TUSD: allowance");
            allowance[from][msg.sender] = allowed - amount;
        }
        return _transfer(from, to, amount);
    }

    function _transfer(address from, address to, uint256 amount) internal returns (bool) {
        require(to != address(0), "TUSD: zero to");
        require(balanceOf[from] >= amount, "TUSD: balance");
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        emit Transfer(from, to, amount);
        return true;
    }
}
