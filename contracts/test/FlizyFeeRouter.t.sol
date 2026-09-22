// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {FlizyFeeRouter} from "../src/dex/FlizyFeeRouter.sol";
import {IERC20} from "../src/dex/IERC20.sol";

/**
 * FlizyFeeRouter is the contract every site swap goes through, and it shipped
 * to GIWA Sepolia with no tests at all. Swapping is the most used thing in the
 * product by a wide margin, so this is the highest traffic code in the repo.
 *
 * The block that matters most here is `refunds`: the router refunded its whole
 * balance rather than the part of this call that went unused, which let any
 * caller sweep whatever the contract was holding.
 */

/** Minimal mintable ERC20. Enough for transfer, approve and transferFrom. */
contract MockERC20 is IERC20 {
    string public name = "Mock";
    string public symbol = "MOCK";
    uint8 public decimals = 18;
    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
        totalSupply += amount;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        require(balanceOf[msg.sender] >= amount, "BAL");
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        return true;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        require(balanceOf[from] >= amount, "BAL");
        uint256 a = allowance[from][msg.sender];
        require(a >= amount, "ALLOWANCE");
        if (a != type(uint256).max) allowance[from][msg.sender] = a - amount;
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        return true;
    }
}

/**
 * Stand-in for the V2 router.
 *
 * `addLiquidityETH` deliberately consumes less than it is offered, because the
 * refund path is what is under test and a mock that consumed everything would
 * never exercise it.
 */
contract MockV2Router {
    address public immutable wethAddr;
    MockERC20 public immutable tokenOut;
    uint256 public constant RATE = 2;

    // Fraction of the offer addLiquidityETH actually uses.
    uint256 public constant LIQ_NUM = 3;
    uint256 public constant LIQ_DEN = 4;

    constructor(address _weth, MockERC20 _tokenOut) {
        wethAddr = _weth;
        tokenOut = _tokenOut;
    }

    receive() external payable {}

    function WETH() external view returns (address) {
        return wethAddr;
    }

    function getAmountsOut(uint256 amountIn, address[] memory path)
        external
        pure
        returns (uint256[] memory amounts)
    {
        amounts = new uint256[](path.length);
        amounts[0] = amountIn;
        amounts[path.length - 1] = amountIn * RATE;
    }

    function swapExactETHForTokens(uint256, address[] calldata path, address to, uint256)
        external
        payable
        returns (uint256[] memory amounts)
    {
        uint256 out = msg.value * RATE;
        tokenOut.mint(to, out);
        amounts = new uint256[](path.length);
        amounts[0] = msg.value;
        amounts[path.length - 1] = out;
    }

    function swapExactTokensForETH(
        uint256 amountIn,
        uint256,
        address[] calldata path,
        address to,
        uint256
    ) external returns (uint256[] memory amounts) {
        require(IERC20(path[0]).transferFrom(msg.sender, address(this), amountIn), "PULL");
        uint256 out = amountIn / RATE;
        (bool ok, ) = to.call{value: out}("");
        require(ok, "ETH_OUT");
        amounts = new uint256[](path.length);
        amounts[0] = amountIn;
        amounts[path.length - 1] = out;
    }

    function swapExactTokensForTokens(
        uint256 amountIn,
        uint256,
        address[] calldata path,
        address to,
        uint256
    ) external returns (uint256[] memory amounts) {
        require(IERC20(path[0]).transferFrom(msg.sender, address(this), amountIn), "PULL");
        uint256 out = amountIn * RATE;
        tokenOut.mint(to, out);
        amounts = new uint256[](path.length);
        amounts[0] = amountIn;
        amounts[path.length - 1] = out;
    }

    function addLiquidityETH(
        address token,
        uint256 amountTokenDesired,
        uint256,
        uint256,
        address,
        uint256
    ) external payable returns (uint256 amountToken, uint256 amountETH, uint256 liquidity) {
        amountToken = (amountTokenDesired * LIQ_NUM) / LIQ_DEN;
        amountETH = (msg.value * LIQ_NUM) / LIQ_DEN;
        require(IERC20(token).transferFrom(msg.sender, address(this), amountToken), "PULL");
        // Hand back the ETH this mock did not consume, the way a real pair does.
        (bool ok, ) = msg.sender.call{value: msg.value - amountETH}("");
        require(ok, "ETH_BACK");
        liquidity = amountToken;
    }
}

contract FlizyFeeRouterTest is Test {
    FlizyFeeRouter internal router;
    MockV2Router internal v2;
    MockERC20 internal tokenIn;
    MockERC20 internal tokenOut;

    address internal weth = address(0xE7E7);
    address internal treasury = address(0x7EA5);
    address internal alice = address(0xA11CE);
    address internal bob = address(0xB0B);

    uint16 internal constant FEE = 30; // 0.30%

    function setUp() public {
        tokenIn = new MockERC20();
        tokenOut = new MockERC20();
        v2 = new MockV2Router(weth, tokenOut);
        router = new FlizyFeeRouter(address(v2), treasury, FEE);
        vm.deal(address(v2), 100 ether);
        vm.deal(alice, 100 ether);
        vm.deal(bob, 100 ether);
    }

    function _path(address a, address b) internal pure returns (address[] memory p) {
        p = new address[](2);
        p[0] = a;
        p[1] = b;
    }

    // ---------------------------------------------------------------- fee math

    function testQuoteFeeSplitsAmount() public view {
        (uint256 fee, uint256 after_) = router.quoteFee(1 ether);
        assertEq(fee, 0.003 ether);
        assertEq(after_, 0.997 ether);
        assertEq(fee + after_, 1 ether);
    }

    function testQuoteFeeRoundsDownAndNeverExceedsInput() public view {
        (uint256 fee, uint256 after_) = router.quoteFee(1);
        assertEq(fee, 0);
        assertEq(after_, 1);
    }

    // ----------------------------------------------------------- access control

    function testOnlyOwnerSetsFee() public {
        vm.prank(alice);
        vm.expectRevert(bytes("NOT_OWNER"));
        router.setFeeBps(10);
    }

    function testFeeCannotExceedCap() public {
        // Read the cap first: vm.expectRevert binds to the very next call, and
        // MAX_FEE_BPS() is itself a call that does not revert.
        uint16 cap = router.MAX_FEE_BPS();

        vm.expectRevert(bytes("FEE_TOO_HIGH"));
        router.setFeeBps(cap + 1);

        router.setFeeBps(cap);
        assertEq(router.feeBps(), cap);
    }

    function testConstructorRejectsTooHighFeeAndZeroAddresses() public {
        vm.expectRevert(bytes("FEE_TOO_HIGH"));
        new FlizyFeeRouter(address(v2), treasury, 101);
        vm.expectRevert(bytes("ZERO"));
        new FlizyFeeRouter(address(0), treasury, FEE);
        vm.expectRevert(bytes("ZERO"));
        new FlizyFeeRouter(address(v2), address(0), FEE);
    }

    function testOnlyOwnerSetsTreasuryAndRejectsZero() public {
        vm.prank(alice);
        vm.expectRevert(bytes("NOT_OWNER"));
        router.setTreasury(alice);

        vm.expectRevert(bytes("ZERO"));
        router.setTreasury(address(0));

        router.setTreasury(bob);
        assertEq(router.treasury(), bob);
    }

    function testOwnershipTransferMovesControl() public {
        router.transferOwnership(alice);
        assertEq(router.owner(), alice);

        vm.expectRevert(bytes("NOT_OWNER"));
        router.setFeeBps(10);

        vm.prank(alice);
        router.setFeeBps(10);
        assertEq(router.feeBps(), 10);
    }

    // ------------------------------------------------------------------- swaps

    function testSwapEthForTokensPaysTreasuryAndSwapsRemainder() public {
        uint256 before = treasury.balance;
        vm.prank(alice);
        router.swapExactETHForTokens{value: 1 ether}(0, _path(weth, address(tokenOut)), alice, block.timestamp);

        assertEq(treasury.balance - before, 0.003 ether, "fee to treasury");
        assertEq(tokenOut.balanceOf(alice), 0.997 ether * 2, "swapped net of fee");
        assertEq(address(router).balance, 0, "router keeps nothing");
    }

    function testSwapEthRejectsWrongPathAndDustAmount() public {
        vm.prank(alice);
        vm.expectRevert(bytes("PATH_WETH"));
        router.swapExactETHForTokens{value: 1 ether}(0, _path(address(tokenIn), address(tokenOut)), alice, block.timestamp);

        address[] memory one = new address[](1);
        one[0] = weth;
        vm.prank(alice);
        vm.expectRevert(bytes("PATH"));
        router.swapExactETHForTokens{value: 1 ether}(0, one, alice, block.timestamp);

        vm.prank(alice);
        vm.expectRevert(bytes("AMOUNT"));
        router.swapExactETHForTokens{value: 0}(0, _path(weth, address(tokenOut)), alice, block.timestamp);
    }

    function testSwapTokensForEthTakesFeeInTheInputToken() public {
        tokenIn.mint(alice, 1000 ether);
        vm.startPrank(alice);
        tokenIn.approve(address(router), type(uint256).max);
        router.swapExactTokensForETH(100 ether, 0, _path(address(tokenIn), weth), alice, block.timestamp);
        vm.stopPrank();

        assertEq(tokenIn.balanceOf(treasury), 0.3 ether, "0.30% of 100");
        assertEq(tokenIn.balanceOf(address(router)), 0, "router keeps no token");
    }

    function testSwapTokensForTokensTakesFeeAndForwards() public {
        tokenIn.mint(alice, 1000 ether);
        vm.startPrank(alice);
        tokenIn.approve(address(router), type(uint256).max);
        router.swapExactTokensForTokens(100 ether, 0, _path(address(tokenIn), address(tokenOut)), alice, block.timestamp);
        vm.stopPrank();

        assertEq(tokenIn.balanceOf(treasury), 0.3 ether);
        assertEq(tokenOut.balanceOf(alice), 99.7 ether * 2);
    }

    function testZeroFeeTakesNothing() public {
        router.setFeeBps(0);
        uint256 before = treasury.balance;
        vm.prank(alice);
        router.swapExactETHForTokens{value: 1 ether}(0, _path(weth, address(tokenOut)), alice, block.timestamp);
        assertEq(treasury.balance, before, "no fee at 0 bps");
        assertEq(tokenOut.balanceOf(alice), 2 ether);
    }

    // ----------------------------------------------------------------- refunds

    /**
     * The defect this suite was written for.
     *
     * addLiquidityETH refunded `address(this).balance` and the contract's whole
     * token balance, not the part of THIS call that went unused. The router has
     * a bare `receive()`, so anything sitting in it, from a stray transfer or a
     * previous leftover, belonged to whoever called addLiquidityETH next.
     */
    function testAddLiquidityRefundsOnlyThisCallsUnusedFunds() public {
        // Someone else's ETH and tokens, already in the router.
        vm.deal(address(router), 5 ether);
        tokenIn.mint(address(router), 500 ether);

        tokenIn.mint(bob, 100 ether);
        uint256 bobEthBefore = bob.balance;

        vm.startPrank(bob);
        tokenIn.approve(address(router), type(uint256).max);
        router.addLiquidityETH{value: 4 ether}(address(tokenIn), 100 ether, 0, 0, bob, block.timestamp);
        vm.stopPrank();

        // Bob offered 4 ETH and 100 tokens; the pair took three quarters of each.
        // He is owed exactly the other quarter, and nothing more. Asserted as an
        // absolute balance rather than a subtraction: while the bug was live Bob
        // ended up richer than he started, and `before - after` underflowed
        // instead of failing with a readable number.
        assertEq(bob.balance, bobEthBefore - 3 ether, "bob spent only what the pair used");
        assertEq(tokenIn.balanceOf(bob), 25 ether, "bob got his unused tokens back");

        // The pre-existing balances are untouched.
        assertEq(address(router).balance, 5 ether, "stranded ETH was not swept");
        assertEq(tokenIn.balanceOf(address(router)), 500 ether, "stranded tokens were not swept");
    }

    function testAddLiquidityWithNothingLeftOverRefundsNothing() public {
        tokenIn.mint(bob, 100 ether);
        uint256 bobEthBefore = bob.balance;

        vm.startPrank(bob);
        tokenIn.approve(address(router), type(uint256).max);
        router.addLiquidityETH{value: 4 ether}(address(tokenIn), 100 ether, 0, 0, bob, block.timestamp);
        vm.stopPrank();

        assertEq(bob.balance, bobEthBefore - 3 ether);
        assertEq(address(router).balance, 0, "router holds nothing afterwards");
    }

    function testRouterAcceptsEthSoRefundsCanLand() public {
        (bool ok, ) = address(router).call{value: 1 ether}("");
        assertTrue(ok, "receive() must stay, the swap refund path needs it");
        assertEq(address(router).balance, 1 ether);
    }

    // --------------------------------------------------------------- read path

    function testGetAmountsOutQuotesNetOfFee() public view {
        uint256[] memory amounts = router.getAmountsOut(1 ether, _path(weth, address(tokenOut)));
        assertEq(amounts[0], 0.997 ether, "quote is taken after the fee");
        assertEq(amounts[1], 0.997 ether * 2);
    }

    function testFeeBpsViewMatchesStorage() public {
        assertEq(router.feeBpsView(), FEE);
        router.setFeeBps(50);
        assertEq(router.feeBpsView(), 50);
    }
}

/**
 * Property tests.
 *
 * Everything above uses values chosen by hand, which means it only proves the
 * cases already thought of. These explore the input space instead, and they are
 * the ones that would catch a refund formula that is right for 4 ETH and wrong
 * for 1 wei.
 */
contract FlizyFeeRouterFuzzTest is Test {
    FlizyFeeRouter internal router;
    MockV2Router internal v2;
    MockERC20 internal tokenIn;
    MockERC20 internal tokenOut;

    address internal weth = address(0xE7E7);
    address internal treasury = address(0x7EA5);
    address internal bob = address(0xB0B);

    function setUp() public {
        tokenIn = new MockERC20();
        tokenOut = new MockERC20();
        v2 = new MockV2Router(weth, tokenOut);
        router = new FlizyFeeRouter(address(v2), treasury, 30);
        vm.deal(address(v2), 1_000_000 ether);
    }

    /** The fee is never more than the input, and the two halves always reconstruct it. */
    function testFuzzQuoteFeeIsConservative(uint128 amountIn, uint16 bps) public {
        bps = uint16(bound(bps, 0, router.MAX_FEE_BPS()));
        router.setFeeBps(bps);

        (uint256 fee, uint256 afterFee) = router.quoteFee(amountIn);
        assertEq(fee + afterFee, amountIn, "fee and remainder must reconstruct the input");
        assertLe(fee, amountIn, "fee can never exceed the input");
        // 100 bps is the hard cap, so the fee is at most a hundredth.
        assertLe(fee, uint256(amountIn) / 100 + 1, "fee exceeded the cap");
    }

    /**
     * The property the drain violated: whatever the router was holding before a
     * call, it still holds afterwards. A caller may only ever get back their own
     * unused remainder.
     */
    function testFuzzAddLiquidityNeverTouchesStrandedFunds(
        uint96 stranded,
        uint96 strandedToken,
        uint96 offerEth,
        uint96 offerToken
    ) public {
        offerEth = uint96(bound(offerEth, 4, 1_000 ether));
        offerToken = uint96(bound(offerToken, 4, 1_000 ether));
        stranded = uint96(bound(stranded, 0, 1_000 ether));
        strandedToken = uint96(bound(strandedToken, 0, 1_000 ether));

        vm.deal(address(router), stranded);
        tokenIn.mint(address(router), strandedToken);

        tokenIn.mint(bob, offerToken);
        vm.deal(bob, offerEth);

        vm.startPrank(bob);
        tokenIn.approve(address(router), type(uint256).max);
        router.addLiquidityETH{value: offerEth}(
            address(tokenIn), offerToken, 0, 0, bob, block.timestamp
        );
        vm.stopPrank();

        assertEq(address(router).balance, stranded, "stranded ETH must be untouched");
        assertEq(tokenIn.balanceOf(address(router)), strandedToken, "stranded tokens must be untouched");
        // Bob can never end up with more than he brought.
        assertLe(bob.balance, uint256(offerEth), "caller profited from the contract");
        assertLe(tokenIn.balanceOf(bob), uint256(offerToken), "caller profited in tokens");
    }

    /** A swap moves the fee to treasury and leaves the router holding nothing. */
    function testFuzzSwapLeavesRouterEmpty(uint96 amountIn) public {
        amountIn = uint96(bound(amountIn, 1, 10_000 ether));
        address[] memory path = new address[](2);
        path[0] = weth;
        path[1] = address(tokenOut);

        uint256 treasuryBefore = treasury.balance;
        vm.deal(bob, amountIn);
        vm.prank(bob);
        router.swapExactETHForTokens{value: amountIn}(0, path, bob, block.timestamp);

        assertEq(address(router).balance, 0, "router kept ETH after a swap");
        (uint256 fee, ) = router.quoteFee(amountIn);
        assertEq(treasury.balance - treasuryBefore, fee, "treasury got exactly the quoted fee");
    }
}

/** Reenters the router when it receives the ETH refund. */
contract ReentrantCaller {
    FlizyFeeRouter public immutable router;
    address public immutable token;
    bool public tried;
    bool public succeeded;

    constructor(FlizyFeeRouter _router, address _token) {
        router = _router;
        token = _token;
    }

    receive() external payable {
        if (tried) return;
        tried = true;
        try router.addLiquidityETH{value: 1}(token, 1, 0, 0, address(this), block.timestamp) {
            succeeded = true;
        } catch {
            succeeded = false;
        }
    }

    function go(uint256 amountToken) external payable {
        IERC20(token).approve(address(router), type(uint256).max);
        router.addLiquidityETH{value: msg.value}(token, amountToken, 0, 0, address(this), block.timestamp);
    }
}

contract FlizyFeeRouterReentrancyTest is Test {
    FlizyFeeRouter internal router;
    MockV2Router internal v2;
    MockERC20 internal tokenIn;
    MockERC20 internal tokenOut;
    address internal weth = address(0xE7E7);

    function setUp() public {
        tokenIn = new MockERC20();
        tokenOut = new MockERC20();
        v2 = new MockV2Router(weth, tokenOut);
        router = new FlizyFeeRouter(address(v2), address(0x7EA5), 30);
        vm.deal(address(v2), 1_000 ether);
    }

    /**
     * The ETH refund hands control to an address the caller chooses, which is
     * the one moment this contract is reachable mid-call. The guard has to hold
     * there, or a caller could re-enter while the router still holds funds.
     */
    function testRefundCannotBeReentered() public {
        ReentrantCaller attacker = new ReentrantCaller(router, address(tokenIn));
        tokenIn.mint(address(attacker), 100 ether);
        vm.deal(address(attacker), 10 ether);
        vm.deal(address(router), 5 ether); // something worth stealing

        attacker.go{value: 4 ether}(100 ether);

        assertTrue(attacker.tried(), "the refund never reached the attacker");
        assertFalse(attacker.succeeded(), "REENTRANT guard did not hold");
        assertEq(address(router).balance, 5 ether, "stranded ETH survived the attempt");
    }
}
