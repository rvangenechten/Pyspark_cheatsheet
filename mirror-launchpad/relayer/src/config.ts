import "dotenv/config";

function req(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var ${name}`);
  return v;
}

export const config = {
  // Robinhood Chain (EVM)
  evmRpcUrl: process.env.ROBINHOOD_RPC_URL ?? "https://rpc.testnet.chain.robinhood.com",
  evmChainId: Number(process.env.ROBINHOOD_CHAIN_ID ?? 46630),
  gatewayAddress: () => req("GATEWAY_ADDRESS") as `0x${string}`,
  relayerKey: () => req("RELAYER_KEY") as `0x${string}`,
  startBlock: process.env.START_BLOCK ? BigInt(process.env.START_BLOCK) : undefined,
  pollMs: Number(process.env.POLL_MS ?? 3000),

  // Solana
  solanaRpcUrl: process.env.SOLANA_RPC_URL ?? "https://api.mainnet-beta.solana.com",
  /** Base58 secret key or JSON byte array of the vault wallet. */
  vaultKey: () => req("VAULT_KEY"),
  /** USDC mint on Solana (the vault's settlement asset). */
  solanaUsdcMint: process.env.SOLANA_USDC_MINT ?? "EPjFWJd5Wt3rFpusYXYqRAa2V7NLHqGMuhgEGbSq3N9t",

  // Jupiter
  jupiterApiUrl: process.env.JUPITER_API_URL ?? "https://lite-api.jup.ag",
  jupiterApiKey: process.env.JUPITER_API_KEY,
  /** Upper bound on slippage the relayer will accept, even if the user's minOut allows more. */
  maxSlippageBps: Number(process.env.MAX_SLIPPAGE_BPS ?? 300),
  /** Skip (reject) orders that expire sooner than this. */
  minTimeLeftSec: Number(process.env.MIN_TIME_LEFT_SEC ?? 45),

  // HTTP API for the web app
  port: Number(process.env.PORT ?? 8787),
  dataDir: process.env.DATA_DIR ?? "./data",
};
