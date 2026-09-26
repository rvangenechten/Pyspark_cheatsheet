import { config } from "./config.js";

export interface Quote {
  inputMint: string;
  outputMint: string;
  inAmount: string;
  outAmount: string;
  otherAmountThreshold: string;
  slippageBps: number;
  priceImpactPct: string;
  [k: string]: unknown;
}

export interface TokenInfo {
  id: string;
  name: string;
  symbol: string;
  decimals: number;
  icon?: string;
  usdPrice?: number;
  mcap?: number;
  fdv?: number;
  circSupply?: number;
}

async function jup<T>(path: string, init?: RequestInit): Promise<T> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (config.jupiterApiKey) headers["x-api-key"] = config.jupiterApiKey;
  const res = await fetch(`${config.jupiterApiUrl}${path}`, { ...init, headers: { ...headers, ...init?.headers } });
  if (!res.ok) throw new Error(`Jupiter ${path} -> ${res.status}: ${await res.text()}`);
  return (await res.json()) as T;
}

export function getQuote(inputMint: string, outputMint: string, amount: bigint, slippageBps: number): Promise<Quote> {
  const q = new URLSearchParams({
    inputMint,
    outputMint,
    amount: amount.toString(),
    slippageBps: String(slippageBps),
    swapMode: "ExactIn",
  });
  return jup<Quote>(`/swap/v1/quote?${q}`);
}

/** Returns a base64 serialized VersionedTransaction for the vault to sign. */
export async function getSwapTx(quote: Quote, userPublicKey: string): Promise<string> {
  const res = await jup<{ swapTransaction: string }>(`/swap/v1/swap`, {
    method: "POST",
    body: JSON.stringify({
      quoteResponse: quote,
      userPublicKey,
      wrapAndUnwrapSol: true,
      dynamicComputeUnitLimit: true,
      prioritizationFeeLamports: "auto",
    }),
  });
  return res.swapTransaction;
}

/** Name, symbol, decimals, icon, price and mcap of a Solana token. */
export async function getTokenInfo(mint: string): Promise<TokenInfo | undefined> {
  const list = await jup<TokenInfo[]>(`/tokens/v2/search?query=${encodeURIComponent(mint)}`);
  return list.find((t) => t.id === mint);
}
