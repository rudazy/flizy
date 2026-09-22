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

/**
 * @notice Thin fee-taking router over Uniswap V2. Protocol fee accrues to treasury.
 *
 * @dev Assumes plain ERC20s. A fee-on-transfer or rebasing token would deliver
 * less than `amountIn` into this contract while the fee and the approval are
 * still computed from the requested figure, so the swap would revert rather
 * than silently shortchange anyone. Listed assets are standard tokens; do not
 * list a fee-on-transfer token against this router without reworking the pull.
 *
 * @dev The contract is not meant to hold a balance between calls. It accepts
 * ETH because the V2 router returns the unused part of an `addLiquidityETH`
 * offer, and refunds are computed from the amounts the pair reports rather than
 * from this contract's balance. Anything that ends up stranded here stays
 * stranded: there is deliberately no sweep, because a sweep is either a
 * privilege worth arguing about or, as it was before, a gift to whoever calls
 * next.
 */
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

    /// @notice Quote for the amount that will actually reach the pair, fee removed.
    function getAmountsOut(uint256 amountIn, address[] memory path) external view returns (uint256[] memory amounts) {
        (, uint256 afterFee) = quoteFee(amountIn);
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
        // Refund what THIS call did not use, computed from the amounts the pair
        // reported, never from the contract's balance.
        //
        // Reading `balanceOf(address(this))` and `address(this).balance` here
        // refunded everything the router was holding, not just this caller's
        // remainder. With a bare `receive()` that made any stray ETH or token
        // sitting in the contract the property of whoever called this next, for
        // the price of one wei. The test that pins this has the caller walking
        // away 5 ETH richer than he arrived.
        //
        // The pair cannot take more than it was offered, so neither subtraction
        // can underflow.
        uint256 tokenRefund = amountTokenDesired - amountToken;
        if (tokenRefund > 0) {
            require(IERC20(token).transfer(msg.sender, tokenRefund), "REFUND");
        }
        // Drop the unspent allowance before handing control to the caller. The
        // router is not meant to hold this token between calls, and leaving an
        // open claim on a balance it might later hold is the same mistake in a
        // smaller form. Done here, not after the ETH refund, so the contract is
        // fully settled before the one call in this function that reaches an
        // address the caller chooses.
        if (tokenRefund > 0) {
            require(IERC20(token).approve(address(v2Router), 0), "APPROVE_RESET");
        }

        uint256 ethRefund = msg.value - amountETH;
        if (ethRefund > 0) {
            (bool ok, ) = msg.sender.call{value: ethRefund}("");
            require(ok, "ETH_REFUND");
        }
    }

    function _pull(address token, address from, uint256 amount) internal {
        require(IERC20(token).transferFrom(from, address(this), amount), "PULL");
    }
}
