import path from "node:path";
import { parseEventLogs } from "viem";
import { gatewayAbi } from "./abi.js";
import { config } from "./config.js";
import { EvmGateway } from "./gateway.js";
import { getTokenInfo } from "./jupiter.js";
import { Journal } from "./journal.js";
import { Processor } from "./processor.js";
import { startServer } from "./server.js";
import { SolanaVault } from "./vault.js";

const MAX_RANGE = 2_000n;

async function main() {
  const gateway = new EvmGateway();
  const vault = new SolanaVault();
  const journal = new Journal(path.join(config.dataDir, "journal.json"));
  const processor = new Processor({
    gateway,
    vault,
    journal,
    tokenInfo: getTokenInfo,
    usdcMint: config.solanaUsdcMint,
    maxSlippageBps: config.maxSlippageBps,
    minTimeLeftSec: config.minTimeLeftSec,
  });

  console.log(`gateway ${gateway.address} on chain ${config.evmChainId}`);
  console.log(`vault   ${vault.address} on Solana`);
  startServer({ gateway, vault });

  let from = journal.lastBlock !== undefined ? journal.lastBlock + 1n : config.startBlock ?? (await gateway.pub.getBlockNumber());

  // Events whose handler hit a transient error (RPC down etc.). Handlers
  // re-check on-chain status first, so retrying is always safe.
  let retry: (() => Promise<unknown>)[] = [];
  const run = (task: () => Promise<unknown>) =>
    processor.enqueue(task).catch(() => {
      retry.push(task);
    });

  // Poll logs rather than subscribing so nothing is missed across restarts.
  for (;;) {
    try {
      const pending = retry;
      retry = [];
      for (const task of pending) await run(task);

      const head = await gateway.pub.getBlockNumber();
      while (from <= head) {
        const to = from + MAX_RANGE - 1n < head ? from + MAX_RANGE - 1n : head;
        const logs = await gateway.pub.getLogs({ address: gateway.address, fromBlock: from, toBlock: to });
        const events = parseEventLogs({ abi: gatewayAbi, logs });

        for (const ev of events) {
          switch (ev.eventName) {
            case "LaunchRequested":
              await run(() => processor.handleLaunchRequest(ev.args.sourceToken));
              break;
            case "BuyRequested":
              await run(() => processor.handleBuy(ev.args));
              break;
            case "SellRequested":
              await run(() => processor.handleSell(ev.args));
              break;
          }
        }
        journal.lastBlock = to;
        from = to + 1n;
      }
    } catch (e) {
      console.error("poll error:", e);
    }
    await new Promise((r) => setTimeout(r, config.pollMs));
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
