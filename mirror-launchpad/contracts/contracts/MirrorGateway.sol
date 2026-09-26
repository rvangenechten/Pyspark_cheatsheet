// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {MirrorToken} from "./MirrorToken.sol";

/// @title MirrorGateway
/// @notice Launchpad + trade router for mirrored memecoins on this chain.
///
/// Launch: anyone calls `requestLaunch(mint)`; the relayer reads the original
/// token's metadata (name, symbol, decimals, icon) and calls `launch`, which
/// deploys an identical MirrorToken.
///
/// Buy:  user escrows USDC -> relayer buys the real token on Solana through
///       Jupiter into the vault -> `fulfillBuy` mints the same amount here.
/// Sell: user escrows mirror tokens -> relayer sells the same amount out of
///       the vault through Jupiter -> `fulfillSell` burns them and pays USDC.
///
/// Mirror supply therefore always equals the vault balance, so price and
/// market cap follow the original. Every fill carries the Solana tx signature
/// so anyone can audit it. If the relayer doesn't fill before the deadline,
/// the user can cancel and get their escrow back.
///
/// USDC settles against an inventory on each chain (USDC paid in here, USDC
/// paid out on Solana and vice versa), so trades don't wait on a bridge. The
/// owner rebalances the two inventories out of band.
///
/// Trust: the owner is meant to be a multisig (e.g. Safe), handed over with a
/// two-step transfer. The relayer can only fill, reject and launch; USDC paid
/// out to sellers is capped per day, so a leaked relayer key can lose at most
/// that cap before the guardian pauses and the owner rotates the key.
contract MirrorGateway is Ownable2Step, Pausable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    enum Side { Buy, Sell }
    enum Status { None, Pending, Filled, Cancelled }

    struct Order {
        address user;
        address token;      // MirrorToken
        Side side;
        Status status;
        uint64 deadline;    // after this the user may cancel
        uint256 amountIn;   // Buy: net USDC to spend (after fee). Sell: mirror tokens.
        uint256 minOut;     // Buy: min mirror tokens. Sell: min USDC (after fee).
        uint256 feeQuote;   // Buy: fee already taken from the USDC paid in.
    }

    uint16 public constant MAX_FEE_BPS = 500; // 5%
    uint64 public constant MIN_DEADLINE = 2 minutes;

    IERC20 public immutable quoteToken; // USDC on this chain
    string public constant SOURCE_CHAIN = "solana";

    address public relayer;
    /// @notice Can pause (not unpause) for fast incident response.
    address public guardian;
    uint16 public feeBps;
    /// @notice Max USDC paid to sellers per rolling day.
    uint256 public payoutCapPerDay;
    uint256 public payoutWindowStart;
    uint256 public paidOutInWindow;
    uint256 public accruedFees;
    /// @dev USDC held for pending buys; not usable as payout liquidity.
    uint256 public escrowedQuote;

    uint256 public nextOrderId = 1;
    mapping(uint256 => Order) public orders;

    /// @notice source mint => mirror token
    mapping(string => address) public mirrorOf;
    /// @notice mirror token => source mint
    mapping(address => string) public sourceOf;
    address[] public allMirrors;

    event RelayerUpdated(address relayer);
    event GuardianUpdated(address guardian);
    event PayoutCapUpdated(uint256 payoutCapPerDay);
    event FeeUpdated(uint16 feeBps);
    event LaunchRequested(string sourceToken, address indexed requester);
    event Launched(address indexed token, string sourceToken, string name, string symbol, uint8 decimals, string logoURI);
    event BuyRequested(uint256 indexed orderId, address indexed user, address indexed token, string sourceToken, uint256 quoteIn, uint256 minTokensOut, uint64 deadline);
    event SellRequested(uint256 indexed orderId, address indexed user, address indexed token, string sourceToken, uint256 tokensIn, uint256 minQuoteOut, uint64 deadline);
    event BuyFilled(uint256 indexed orderId, uint256 tokensOut, string solanaTx);
    event SellFilled(uint256 indexed orderId, uint256 quoteOut, uint256 fee, string solanaTx);
    event OrderCancelled(uint256 indexed orderId, string reason);
    event LiquidityDeposited(address indexed from, uint256 amount);
    event LiquidityWithdrawn(address indexed to, uint256 amount);
    event FeesWithdrawn(address indexed to, uint256 amount);

    error NotRelayer();
    error AlreadyLaunched();
    error UnknownToken();
    error BadAmount();
    error BadDeadline();
    error BadFee();
    error NotPending();
    error Slippage();
    error NotAllowed();
    error InsufficientLiquidity();
    error PayoutCapExceeded();

    modifier onlyRelayer() {
        if (msg.sender != relayer) revert NotRelayer();
        _;
    }

    constructor(
        address owner_,
        address relayer_,
        address guardian_,
        IERC20 quoteToken_,
        uint16 feeBps_,
        uint256 payoutCapPerDay_
    ) Ownable(owner_) {
        if (feeBps_ > MAX_FEE_BPS) revert BadFee();
        relayer = relayer_;
        guardian = guardian_;
        quoteToken = quoteToken_;
        feeBps = feeBps_;
        payoutCapPerDay = payoutCapPerDay_;
    }

    // ------------------------------------------------------------------
    // Launch
    // ------------------------------------------------------------------

    /// @notice Ask the relayer to mirror `sourceToken` (a Solana mint).
    function requestLaunch(string calldata sourceToken) external whenNotPaused {
        if (mirrorOf[sourceToken] != address(0)) revert AlreadyLaunched();
        emit LaunchRequested(sourceToken, msg.sender);
    }

    /// @notice Deploy the mirror with the original token's metadata.
    function launch(
        string calldata sourceToken,
        string calldata name,
        string calldata symbol,
        uint8 decimals,
        string calldata logoURI
    ) external onlyRelayer whenNotPaused returns (address token) {
        if (mirrorOf[sourceToken] != address(0)) revert AlreadyLaunched();
        token = address(new MirrorToken(name, symbol, decimals, SOURCE_CHAIN, sourceToken, logoURI));
        mirrorOf[sourceToken] = token;
        sourceOf[token] = sourceToken;
        allMirrors.push(token);
        emit Launched(token, sourceToken, name, symbol, decimals, logoURI);
    }

    function setLogoURI(address token, string calldata logoURI) external onlyRelayer {
        _requireMirror(token);
        MirrorToken(token).setLogoURI(logoURI);
    }

    function mirrorCount() external view returns (uint256) {
        return allMirrors.length;
    }

    // ------------------------------------------------------------------
    // Trading (user side)
    // ------------------------------------------------------------------

    /// @notice Pay `quoteIn` USDC for at least `minTokensOut` mirror tokens.
    function buy(address token, uint256 quoteIn, uint256 minTokensOut, uint64 deadline)
        external
        nonReentrant
        whenNotPaused
        returns (uint256 orderId)
    {
        _requireMirror(token);
        if (quoteIn == 0) revert BadAmount();
        _checkDeadline(deadline);

        quoteToken.safeTransferFrom(msg.sender, address(this), quoteIn);
        uint256 fee = (quoteIn * feeBps) / 10_000;
        uint256 net = quoteIn - fee;
        escrowedQuote += quoteIn;

        orderId = nextOrderId++;
        orders[orderId] = Order(msg.sender, token, Side.Buy, Status.Pending, deadline, net, minTokensOut, fee);
        emit BuyRequested(orderId, msg.sender, token, sourceOf[token], net, minTokensOut, deadline);
    }

    /// @notice Sell `tokensIn` mirror tokens for at least `minQuoteOut` USDC (after fee).
    function sell(address token, uint256 tokensIn, uint256 minQuoteOut, uint64 deadline)
        external
        nonReentrant
        whenNotPaused
        returns (uint256 orderId)
    {
        _requireMirror(token);
        if (tokensIn == 0) revert BadAmount();
        _checkDeadline(deadline);

        IERC20(token).safeTransferFrom(msg.sender, address(this), tokensIn);

        orderId = nextOrderId++;
        orders[orderId] = Order(msg.sender, token, Side.Sell, Status.Pending, deadline, tokensIn, minQuoteOut, 0);
        emit SellRequested(orderId, msg.sender, token, sourceOf[token], tokensIn, minQuoteOut, deadline);
    }

    /// @notice Reclaim escrow for an order the relayer didn't fill in time.
    function cancel(uint256 orderId) external nonReentrant {
        Order storage o = orders[orderId];
        if (o.status != Status.Pending) revert NotPending();
        if (msg.sender != o.user || block.timestamp <= o.deadline) revert NotAllowed();
        _refund(orderId, o, "expired");
    }

    // ------------------------------------------------------------------
    // Trading (relayer side)
    // ------------------------------------------------------------------

    /// @notice Mint after the relayer bought `tokensOut` into the Solana vault.
    function fulfillBuy(uint256 orderId, uint256 tokensOut, string calldata solanaTx)
        external
        onlyRelayer
        nonReentrant
    {
        Order storage o = orders[orderId];
        if (o.status != Status.Pending || o.side != Side.Buy) revert NotPending();
        if (tokensOut == 0 || tokensOut < o.minOut) revert Slippage();

        o.status = Status.Filled;
        escrowedQuote -= o.amountIn + o.feeQuote;
        accruedFees += o.feeQuote;
        // The net USDC now backs payouts on this chain; the relayer spent the
        // equivalent from its Solana inventory.
        MirrorToken(o.token).mint(o.user, tokensOut);
        emit BuyFilled(orderId, tokensOut, solanaTx);
    }

    /// @notice Burn and pay out after the relayer sold the vault tokens for `grossQuoteOut`.
    function fulfillSell(uint256 orderId, uint256 grossQuoteOut, string calldata solanaTx)
        external
        onlyRelayer
        nonReentrant
    {
        Order storage o = orders[orderId];
        if (o.status != Status.Pending || o.side != Side.Sell) revert NotPending();

        uint256 fee = (grossQuoteOut * feeBps) / 10_000;
        uint256 net = grossQuoteOut - fee;
        if (net == 0 || net < o.minOut) revert Slippage();
        if (net + fee > availableLiquidity()) revert InsufficientLiquidity();
        _usePayout(net);

        o.status = Status.Filled;
        accruedFees += fee;
        MirrorToken(o.token).burn(o.amountIn);
        quoteToken.safeTransfer(o.user, net);
        emit SellFilled(orderId, net, fee, solanaTx);
    }

    /// @notice Relayer refuses an order (e.g. Jupiter quote below minOut).
    function reject(uint256 orderId, string calldata reason) external onlyRelayer nonReentrant {
        Order storage o = orders[orderId];
        if (o.status != Status.Pending) revert NotPending();
        _refund(orderId, o, reason);
    }

    // ------------------------------------------------------------------
    // Liquidity & admin
    // ------------------------------------------------------------------

    /// @notice USDC available to pay sellers.
    function availableLiquidity() public view returns (uint256) {
        return quoteToken.balanceOf(address(this)) - escrowedQuote - accruedFees;
    }

    /// @notice USDC that can still be paid out to sellers in the current day.
    function payoutRemaining() public view returns (uint256) {
        if (block.timestamp >= payoutWindowStart + 1 days) return payoutCapPerDay;
        return payoutCapPerDay > paidOutInWindow ? payoutCapPerDay - paidOutInWindow : 0;
    }

    /// @notice Largest gross sell the gateway can settle right now.
    function sellHeadroom() external view returns (uint256) {
        uint256 liq = availableLiquidity();
        uint256 cap = payoutRemaining();
        return liq < cap ? liq : cap;
    }

    function depositLiquidity(uint256 amount) external {
        quoteToken.safeTransferFrom(msg.sender, address(this), amount);
        emit LiquidityDeposited(msg.sender, amount);
    }

    function withdrawLiquidity(address to, uint256 amount) external onlyOwner {
        if (amount > availableLiquidity()) revert InsufficientLiquidity();
        quoteToken.safeTransfer(to, amount);
        emit LiquidityWithdrawn(to, amount);
    }

    function withdrawFees(address to) external onlyOwner {
        uint256 amount = accruedFees;
        accruedFees = 0;
        quoteToken.safeTransfer(to, amount);
        emit FeesWithdrawn(to, amount);
    }

    function setRelayer(address relayer_) external onlyOwner {
        relayer = relayer_;
        emit RelayerUpdated(relayer_);
    }

    function setGuardian(address guardian_) external onlyOwner {
        guardian = guardian_;
        emit GuardianUpdated(guardian_);
    }

    function setPayoutCapPerDay(uint256 cap) external onlyOwner {
        payoutCapPerDay = cap;
        emit PayoutCapUpdated(cap);
    }

    function setFeeBps(uint16 feeBps_) external onlyOwner {
        if (feeBps_ > MAX_FEE_BPS) revert BadFee();
        feeBps = feeBps_;
        emit FeeUpdated(feeBps_);
    }

    /// @notice Owner or guardian can pause; only the owner can unpause.
    function pause() external {
        if (msg.sender != owner() && msg.sender != guardian) revert OwnableUnauthorizedAccount(msg.sender);
        _pause();
    }

    function unpause() external onlyOwner {
        _unpause();
    }

    // ------------------------------------------------------------------
    // Internals
    // ------------------------------------------------------------------

    function _usePayout(uint256 amount) private {
        if (block.timestamp >= payoutWindowStart + 1 days) {
            payoutWindowStart = block.timestamp;
            paidOutInWindow = 0;
        }
        paidOutInWindow += amount;
        if (paidOutInWindow > payoutCapPerDay) revert PayoutCapExceeded();
    }

    function _refund(uint256 orderId, Order storage o, string memory reason) private {
        o.status = Status.Cancelled;
        if (o.side == Side.Buy) {
            uint256 total = o.amountIn + o.feeQuote;
            escrowedQuote -= total;
            quoteToken.safeTransfer(o.user, total);
        } else {
            IERC20(o.token).safeTransfer(o.user, o.amountIn);
        }
        emit OrderCancelled(orderId, reason);
    }

    function _requireMirror(address token) private view {
        if (bytes(sourceOf[token]).length == 0) revert UnknownToken();
    }

    function _checkDeadline(uint64 deadline) private view {
        if (deadline < block.timestamp + MIN_DEADLINE) revert BadDeadline();
    }
}
