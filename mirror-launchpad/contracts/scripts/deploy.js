// Deploys MirrorGateway. On testnet, deploys MockUSDC too unless QUOTE_TOKEN is set.
//
//   DEPLOYER_KEY=0x... OWNER_ADDRESS=0x<Safe> RELAYER_ADDRESS=0x... GUARDIAN_ADDRESS=0x... \
//     npx hardhat run scripts/deploy.js --network robinhoodTestnet
//
// OWNER_ADDRESS should be a multisig (Safe). On live networks the script
// refuses a plain wallet as owner unless ALLOW_EOA_OWNER=1.
const { ethers, network } = require("hardhat");

const LOCAL = ["hardhat", "localhost"].includes(network.name);

async function main() {
  const [deployer] = await ethers.getSigners();
  const owner = process.env.OWNER_ADDRESS || (LOCAL ? deployer.address : undefined);
  const relayer = process.env.RELAYER_ADDRESS || (LOCAL ? deployer.address : undefined);
  const guardian = process.env.GUARDIAN_ADDRESS || (LOCAL ? deployer.address : undefined);
  if (!owner || !relayer || !guardian) throw new Error("Set OWNER_ADDRESS, RELAYER_ADDRESS and GUARDIAN_ADDRESS");
  if (!LOCAL && (await ethers.provider.getCode(owner)) === "0x" && process.env.ALLOW_EOA_OWNER !== "1") {
    throw new Error(`OWNER_ADDRESS ${owner} is not a contract. Use a Safe multisig (or ALLOW_EOA_OWNER=1 for a throwaway test).`);
  }
  const feeBps = Number(process.env.FEE_BPS || 100);
  const payoutCap = BigInt(process.env.PAYOUT_CAP_USDC || 10_000) * 10n ** 6n;

  let quote = process.env.QUOTE_TOKEN;
  if (!quote) {
    if (network.name === "robinhood") throw new Error("Set QUOTE_TOKEN to USDC on mainnet");
    const usdc = await (await ethers.getContractFactory("MockUSDC")).deploy();
    await usdc.waitForDeployment();
    quote = await usdc.getAddress();
    console.log("MockUSDC     ", quote);
  }

  const gw = await (await ethers.getContractFactory("MirrorGateway")).deploy(owner, relayer, guardian, quote, feeBps, payoutCap);
  await gw.waitForDeployment();

  console.log("MirrorGateway", await gw.getAddress());
  console.log("owner        ", owner);
  console.log("relayer      ", relayer);
  console.log("guardian     ", guardian);
  console.log("feeBps       ", feeBps);
  console.log("payout cap   ", `${payoutCap / 10n ** 6n} USDC/day`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
