import { parseAbi } from "viem";

export const gatewayAbi = parseAbi([
  "event LaunchRequested(string sourceToken, address indexed requester)",
  "event Launched(address indexed token, string sourceToken, string name, string symbol, uint8 decimals, string logoURI)",
  "event BuyRequested(uint256 indexed orderId, address indexed user, address indexed token, string sourceToken, uint256 quoteIn, uint256 minTokensOut, uint64 deadline)",
  "event SellRequested(uint256 indexed orderId, address indexed user, address indexed token, string sourceToken, uint256 tokensIn, uint256 minQuoteOut, uint64 deadline)",

  "function launch(string sourceToken, string name, string symbol, uint8 decimals, string logoURI) returns (address)",
  "function fulfillBuy(uint256 orderId, uint256 tokensOut, string solanaTx)",
  "function fulfillSell(uint256 orderId, uint256 grossQuoteOut, string solanaTx)",
  "function reject(uint256 orderId, string reason)",

  "function orders(uint256) view returns (address user, address token, uint8 side, uint8 status, uint64 deadline, uint256 amountIn, uint256 minOut, uint256 feeQuote)",
  "function mirrorOf(string) view returns (address)",
  "function sourceOf(address) view returns (string)",
  "function allMirrors(uint256) view returns (address)",
  "function mirrorCount() view returns (uint256)",
  "function feeBps() view returns (uint16)",
  "function availableLiquidity() view returns (uint256)",
  "function quoteToken() view returns (address)",
]);

export const mirrorTokenAbi = parseAbi([
  "function name() view returns (string)",
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
  "function totalSupply() view returns (uint256)",
  "function logoURI() view returns (string)",
  "function sourceToken() view returns (string)",
]);

export const OrderStatus = { None: 0, Pending: 1, Filled: 2, Cancelled: 3 } as const;
