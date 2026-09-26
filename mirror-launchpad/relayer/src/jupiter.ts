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
    // Leave room in the transaction for the vault program's own accounts.
    maxAccounts: "48",
  });
  return jup<Quote>(`/swap/v1/quote?${q}`);
}

export interface JupIx {
  programId: string;
  accounts: { pubkey: string; isSigner: boolean; isWritable: boolean }[];
  data: string; // base64
}

export interface SwapInstructions {
  computeBudgetInstructions: JupIx[];
  setupInstructions: JupIx[];
  swapInstruction: JupIx;
  cleanupInstruction?: JupIx;
  addressLookupTableAddresses: string[];
}

/**
 * Raw swap instruction for `user` (the vault PDA), paying out to
 * `destinationTokenAccount` (the vault's own ATA). The vault program wraps
 * it and signs for the PDA.
 */
export function getSwapInstructions(quote: Quote, user: string, destinationTokenAccount: string): Promise<SwapInstructions> {
  return jup<SwapInstructions>(`/swap/v1/swap-instructions`, {
    method: "POST",
    body: JSON.stringify({
      quoteResponse: quote,
      userPublicKey: user,
      destinationTokenAccount,
      useSharedAccounts: true,
      wrapAndUnwrapSol: false,
      prioritizationFeeLamports: "auto",
    }),
  });
}

/** Name, symbol, decimals, icon, price and mcap of a Solana token. */
export async function getTokenInfo(mint: string): Promise<TokenInfo | undefined> {
  const list = await jup<TokenInfo[]>(`/tokens/v2/search?query=${encodeURIComponent(mint)}`);
  return list.find((t) => t.id === mint);
}
