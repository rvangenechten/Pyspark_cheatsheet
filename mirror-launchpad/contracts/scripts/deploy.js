// Deploys MirrorGateway. On testnet, deploys MockUSDC too unless QUOTE_TOKEN is set.
//   DEPLOYER_KEY=0x... RELAYER_ADDRESS=0x... npx hardhat run scripts/deploy.js --network robinhoodTestnet
const { ethers, network } = require("hardhat");

async function main() {
  const [deployer] = await ethers.getSigners();
  const owner = process.env.OWNER_ADDRESS || deployer.address;
  const relayer = process.env.RELAYER_ADDRESS || deployer.address;
  const feeBps = Number(process.env.FEE_BPS || 100);

  let quote = process.env.QUOTE_TOKEN;
  if (!quote) {
    if (network.name === "robinhood") throw new Error("Set QUOTE_TOKEN to USDC on mainnet");
    const usdc = await (await ethers.getContractFactory("MockUSDC")).deploy();
    await usdc.waitForDeployment();
    quote = await usdc.getAddress();
    console.log("MockUSDC     ", quote);
  }

  const gw = await (await ethers.getContractFactory("MirrorGateway")).deploy(owner, relayer, quote, feeBps);
  await gw.waitForDeployment();

  console.log("MirrorGateway", await gw.getAddress());
  console.log("owner        ", owner);
  console.log("relayer      ", relayer);
  console.log("feeBps       ", feeBps);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
