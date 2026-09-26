import http from "node:http";
import type { Address } from "viem";
import { gatewayAbi, mirrorTokenAbi } from "./abi.js";
import { config } from "./config.js";
import type { EvmGateway } from "./gateway.js";
import { getTokenInfo } from "./jupiter.js";
import type { SolanaVault } from "./vault.js";

interface Ctx {
  gateway: EvmGateway;
  vault: SolanaVault;
}

export interface MirrorView {
  address: Address;
  sourceToken: string;
  name: string;
  symbol: string;
  decimals: number;
  logoURI: string;
  mirrorSupply: string;
  vaultBalance: string;
  fullyBacked: boolean;
  usdPrice?: number;
  sourceMcap?: number;
}

/** All mirrors with their proof of reserves: vault balance on Solana vs supply here. */
export async function listMirrors({ gateway, vault }: Ctx): Promise<MirrorView[]> {
  const pub = gateway.pub;
  const n = await pub.readContract({ address: gateway.address, abi: gatewayAbi, functionName: "mirrorCount" });
  const out: MirrorView[] = [];
  for (let i = 0n; i < n; i++) {
    const address = await pub.readContract({ address: gateway.address, abi: gatewayAbi, functionName: "allMirrors", args: [i] });
    const r = (functionName: "name" | "symbol" | "decimals" | "totalSupply" | "logoURI" | "sourceToken") =>
      pub.readContract({ address, abi: mirrorTokenAbi, functionName });
    const [name, symbol, decimals, supply, logoURI, sourceToken] = await Promise.all([
      r("name"), r("symbol"), r("decimals"), r("totalSupply"), r("logoURI"), r("sourceToken"),
    ]) as [string, string, number, bigint, string, string];
    const [held, info] = await Promise.all([vault.balance(sourceToken), getTokenInfo(sourceToken).catch(() => undefined)]);
    out.push({
      address,
      sourceToken,
      name,
      symbol,
      decimals,
      logoURI,
      mirrorSupply: supply.toString(),
      vaultBalance: held.toString(),
      fullyBacked: held >= supply,
      usdPrice: info?.usdPrice,
      sourceMcap: info?.mcap,
    });
  }
  return out;
}

export function startServer(ctx: Ctx) {
  const server = http.createServer(async (req, res) => {
    res.setHeader("access-control-allow-origin", "*");
    res.setHeader("content-type", "application/json");
    const url = new URL(req.url ?? "/", "http://x");
    const send = (code: number, body: unknown) =>
      res.writeHead(code).end(JSON.stringify(body, (_, v) => (typeof v === "bigint" ? v.toString() : v)));

    try {
      if (url.pathname === "/api/config") {
        const quoteToken = await ctx.gateway.pub.readContract({ address: ctx.gateway.address, abi: gatewayAbi, functionName: "quoteToken" });
        return send(200, {
          chainId: config.evmChainId,
          rpcUrl: config.evmRpcUrl,
          gateway: ctx.gateway.address,
          quoteToken,
          feeBps: await ctx.gateway.feeBps(),
          vault: ctx.vault.address,
        });
      }
      if (url.pathname === "/api/mirrors") return send(200, await listMirrors(ctx));
      if (url.pathname === "/api/token") {
        const info = await getTokenInfo(url.searchParams.get("mint") ?? "");
        return info ? send(200, info) : send(404, { error: "unknown token" });
      }
      if (url.pathname === "/api/quote") {
        // side=buy: amount is USDC in; side=sell: amount is tokens in (raw units)
        const side = url.searchParams.get("side");
        const mint = url.searchParams.get("mint") ?? "";
        const amount = BigInt(url.searchParams.get("amount") ?? "0");
        const [inM, outM] = side === "sell" ? [mint, config.solanaUsdcMint] : [config.solanaUsdcMint, mint];
        const q = await ctx.vault.quote(inM, outM, amount, config.maxSlippageBps);
        return send(200, { outAmount: q.outAmount, priceImpactPct: q.priceImpactPct });
      }
      send(404, { error: "not found" });
    } catch (e) {
      send(500, { error: (e as Error).message });
    }
  });
  server.listen(config.port, () => console.log(`api     http://localhost:${config.port}`));
  return server;
}
