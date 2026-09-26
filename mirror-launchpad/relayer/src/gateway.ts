import {
  createPublicClient,
  createWalletClient,
  defineChain,
  http,
  parseEventLogs,
  type Address,
  type PublicClient,
  type WalletClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { gatewayAbi } from "./abi.js";
import { config } from "./config.js";
import type { Gateway, OrderState } from "./processor.js";

export const robinhoodChain = defineChain({
  id: config.evmChainId,
  name: config.evmChainId === 4663 ? "Robinhood Chain" : "Robinhood Chain Testnet",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [config.evmRpcUrl] } },
});

export function publicClient(): PublicClient {
  return createPublicClient({ chain: robinhoodChain, transport: http(config.evmRpcUrl) });
}

export class EvmGateway implements Gateway {
  readonly address: Address;
  readonly pub: PublicClient;
  private readonly wallet: WalletClient;

  constructor() {
    this.address = config.gatewayAddress();
    this.pub = publicClient();
    this.wallet = createWalletClient({
      account: privateKeyToAccount(config.relayerKey()),
      chain: robinhoodChain,
      transport: http(config.evmRpcUrl),
    });
  }

  private read<T>(functionName: string, args: unknown[] = []): Promise<T> {
    return this.pub.readContract({ address: this.address, abi: gatewayAbi, functionName, args } as never) as Promise<T>;
  }

  /** Simulate, send, and wait for a relayer transaction. */
  private async write(functionName: string, args: unknown[]) {
    const { request, result } = await this.pub.simulateContract({
      address: this.address,
      abi: gatewayAbi,
      functionName,
      args,
      account: this.wallet.account!,
    } as never);
    const hash = await this.wallet.writeContract(request as never);
    const receipt = await this.pub.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success") throw new Error(`${functionName} reverted: ${hash}`);
    return { hash, result, receipt };
  }

  async getOrder(id: bigint): Promise<OrderState> {
    const [, , , status, deadline, amountIn, minOut] = await this.read<readonly [string, string, number, number, bigint, bigint, bigint, bigint]>("orders", [id]);
    return { status, deadline, amountIn, minOut };
  }

  async mirrorOf(sourceToken: string) {
    const a = await this.read<Address>("mirrorOf", [sourceToken]);
    return /^0x0{40}$/.test(a) ? undefined : a;
  }

  async feeBps() {
    return Number(await this.read<number>("feeBps"));
  }

  sellHeadroom() {
    return this.read<bigint>("sellHeadroom");
  }

  async launch(sourceToken: string, name: string, symbol: string, decimals: number, logoURI: string) {
    const { receipt } = await this.write("launch", [sourceToken, name, symbol, decimals, logoURI]);
    const [ev] = parseEventLogs({ abi: gatewayAbi, eventName: "Launched", logs: receipt.logs });
    return ev.args.token;
  }

  async fulfillBuy(id: bigint, tokensOut: bigint, solanaTx: string) {
    return (await this.write("fulfillBuy", [id, tokensOut, solanaTx])).hash;
  }

  async fulfillSell(id: bigint, grossQuoteOut: bigint, solanaTx: string) {
    return (await this.write("fulfillSell", [id, grossQuoteOut, solanaTx])).hash;
  }

  async reject(id: bigint, reason: string) {
    return (await this.write("reject", [id, reason])).hash;
  }
}
