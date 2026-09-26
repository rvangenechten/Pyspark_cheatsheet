// Proof-of-reserves check: every mirror's supply must be covered by the vault.
//   npm run reserves
import { EvmGateway } from "./gateway.js";
import { listMirrors } from "./server.js";
import { SolanaVault } from "./vault.js";

const mirrors = await listMirrors({ gateway: new EvmGateway(), vault: new SolanaVault() });
let ok = true;
for (const m of mirrors) {
  ok &&= m.fullyBacked;
  console.log(`${m.fullyBacked ? "OK  " : "SHORT"} ${m.symbol.padEnd(10)} supply ${m.mirrorSupply.padStart(20)}  vault ${m.vaultBalance.padStart(20)}  ${m.address}`);
}
process.exit(ok ? 0 : 1);
