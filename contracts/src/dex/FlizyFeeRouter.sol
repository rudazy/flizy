// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "./IERC20.sol";

interface IUniswapV2RouterMinimal {
    function WETH() external view returns (address);
    function swapExactETHForTokens(uint256 amountOutMin, address[] calldata path, address to, uint256 deadline)
        external
        payable
        returns (uint256[] memory amounts);
    function swapExactTokensForETH(
        uint256 amountIn,
        uint256 amountOutMin,
        address[] calldata path,
        address to,
        uint256 deadline
    ) external returns (uint256[] memory amounts);
    function swapExactTokensForTokens(
        uint256 amountIn,
        uint256 amountOutMin,
        address[] calldata path,
        address to,
        uint256 deadline
    ) external returns (uint256[] memory amounts);
    function getAmountsOut(uint256 amountIn, address[] memory path) external view returns (uint256[] memory amounts);
    function addLiquidityETH(
        address token,
        uint256 amountTokenDesired,
        uint256 amountTokenMin,
        uint256 amountETHMin,
        address to,
        uint256 deadline
    ) external payable returns (uint256 amountToken, uint256 amountETH, uint256 liquidity);
}

/// @notice Thin fee-taking router over Uniswap V2. Protocol fee accrues to treasury.
contract FlizyFeeRouter {
    IUniswapV2RouterMinimal public immutable v2Router;
    address public owner;
    address public treasury;
    /// @notice Fee in basis points (30 = 0.30%).
    uint16 public feeBps;
    /// @notice Hard cap so fee cannot be raised abusively (100 = 1%).
    uint16 public constant MAX_FEE_BPS = 100;

    uint256 private locked = 1;

    event FeeUpdated(uint16 feeBps);
    event TreasuryUpdated(address treasury);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);
    event FeeTaken(address indexed payer, address token, uint256 amount);

    modifier onlyOwner() {
        require(msg.sender == owner, "NOT_OWNER");
        _;
    }

    modifier nonReentrant() {
        require(locked == 1, "REENTRANT");
        locked = 2;
        _;
        locked = 1;
    }

    constructor(address _v2Router, address _treasury, uint16 _feeBps) {
        require(_v2Router != address(0) && _treasury != address(0), "ZERO");
        require(_feeBps <= MAX_FEE_BPS, "FEE_TOO_HIGH");
        v2Router = IUniswapV2RouterMinimal(_v2Router);
        owner = msg.sender;
        treasury = _treasury;
        feeBps = _feeBps;
    }

    receive() external payable {}

    function setFeeBps(uint16 _feeBps) external onlyOwner {
        require(_feeBps <= MAX_FEE_BPS, "FEE_TOO_HIGH");
        feeBps = _feeBps;
        emit FeeUpdated(_feeBps);
    }

    function setTreasury(address _treasury) external onlyOwner {
        require(_treasury != address(0), "ZERO");
        treasury = _treasury;
        emit TreasuryUpdated(_treasury);
    }

    function transferOwnership(address newOwner) external onlyOwner {
        require(newOwner != address(0), "ZERO");
        emit OwnershipTransferred(owner, newOwner);
        owner = newOwner;
    }

    function quoteFee(uint256 amountIn) public view returns (uint256 feeAmount, uint256 amountAfterFee) {
        feeAmount = (amountIn * feeBps) / 10_000;
        amountAfterFee = amountIn - feeAmount;
    }

    function getAmountsOut(uint256 amountIn, address[] memory path) external view returns (uint256[] memory amounts) {
        (uint256 feeAmount, uint256 afterFee) = quoteFee(amountIn);
        // silence unused when feeBps is 0
        feeAmount;
        return v2Router.getAmountsOut(afterFee, path);
    }

    function feeBpsView() external view returns (uint16) {
        return feeBps;
    }

    function swapExactETHForTokens(uint256 amountOutMin, address[] calldata path, address to, uint256 deadline)
        external
        payable
        nonReentrant
        returns (uint256[] memory amounts)
    {
        require(path.length >= 2, "PATH");
        require(path[0] == v2Router.WETH(), "PATH_WETH");
        (uint256 feeAmount, uint256 afterFee) = quoteFee(msg.value);
        require(afterFee > 0, "AMOUNT");
        if (feeAmount > 0) {
            (bool ok, ) = treasury.call{value: feeAmount}("");
            require(ok, "FEE_XFER");
            emit FeeTaken(msg.sender, address(0), feeAmount);
        }
        amounts = v2Router.swapExactETHForTokens{value: afterFee}(amountOutMin, path, to, deadline);
    }

    function swapExactTokensForETH(
        uint256 amountIn,
        uint256 amountOutMin,
        address[] calldata path,
        address to,
        uint256 deadline
    ) external nonReentrant returns (uint256[] memory amounts) {
        require(path.length >= 2, "PATH");
        require(path[path.length - 1] == v2Router.WETH(), "PATH_WETH");
        (uint256 feeAmount, uint256 afterFee) = quoteFee(amountIn);
        require(afterFee > 0, "AMOUNT");
        _pull(path[0], msg.sender, amountIn);
        if (feeAmount > 0) {
            require(IERC20(path[0]).transfer(treasury, feeAmount), "FEE_XFER");
            emit FeeTaken(msg.sender, path[0], feeAmount);
        }
        require(IERC20(path[0]).approve(address(v2Router), afterFee), "APPROVE");
        amounts = v2Router.swapExactTokensForETH(afterFee, amountOutMin, path, to, deadline);
    }

    function swapExactTokensForTokens(
        uint256 amountIn,
        uint256 amountOutMin,
        address[] calldata path,
        address to,
        uint256 deadline
    ) external nonReentrant returns (uint256[] memory amounts) {
        require(path.length >= 2, "PATH");
        (uint256 feeAmount, uint256 afterFee) = quoteFee(amountIn);
        require(afterFee > 0, "AMOUNT");
        _pull(path[0], msg.sender, amountIn);
        if (feeAmount > 0) {
            require(IERC20(path[0]).transfer(treasury, feeAmount), "FEE_XFER");
            emit FeeTaken(msg.sender, path[0], feeAmount);
        }
        require(IERC20(path[0]).approve(address(v2Router), afterFee), "APPROVE");
        amounts = v2Router.swapExactTokensForTokens(afterFee, amountOutMin, path, to, deadline);
    }

    /// @notice Pass-through add liquidity (no protocol fee on LP add).
    function addLiquidityETH(
        address token,
        uint256 amountTokenDesired,
        uint256 amountTokenMin,
        uint256 amountETHMin,
        address to,
        uint256 deadline
    ) external payable nonReentrant returns (uint256 amountToken, uint256 amountETH, uint256 liquidity) {
        _pull(token, msg.sender, amountTokenDesired);
        require(IERC20(token).approve(address(v2Router), amountTokenDesired), "APPROVE");
        (amountToken, amountETH, liquidity) = v2Router.addLiquidityETH{value: msg.value}(
            token, amountTokenDesired, amountTokenMin, amountETHMin, to, deadline
        );
        // refund unused token
        uint256 leftover = IERC20(token).balanceOf(address(this));
        if (leftover > 0) {
            require(IERC20(token).transfer(msg.sender, leftover), "REFUND");
        }
        uint256 ethLeft = address(this).balance;
        if (ethLeft > 0) {
            (bool ok, ) = msg.sender.call{value: ethLeft}("");
            require(ok, "ETH_REFUND");
        }
    }

    function _pull(address token, address from, uint256 amount) internal {
        require(IERC20(token).transferFrom(from, address(this), amount), "PULL");
    }
}
