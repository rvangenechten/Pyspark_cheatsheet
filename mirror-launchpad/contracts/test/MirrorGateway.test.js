const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

const BONK = "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263";
const usdc = (n) => ethers.parseUnits(String(n), 6);
const bonk = (n) => ethers.parseUnits(String(n), 5);

describe("MirrorGateway", () => {
  let owner, relayer, alice, bob, quote, gw, token;

  async function deadline(secs = 600) {
    return (await time.latest()) + secs;
  }

  beforeEach(async () => {
    [owner, relayer, alice, bob] = await ethers.getSigners();
    quote = await (await ethers.getContractFactory("MockUSDC")).deploy();
    gw = await (await ethers.getContractFactory("MirrorGateway")).deploy(owner, relayer, quote, 100); // 1%

    await gw.connect(relayer).launch(BONK, "Bonk", "Bonk", 5, "https://arweave.net/bonk.png");
    token = await ethers.getContractAt("MirrorToken", await gw.mirrorOf(BONK));

    for (const s of [alice, bob, owner]) {
      await quote.mint(s, usdc(10_000));
      await quote.connect(s).approve(gw, ethers.MaxUint256);
    }
  });

  describe("launch", () => {
    it("copies the original metadata", async () => {
      expect(await token.name()).to.equal("Bonk");
      expect(await token.symbol()).to.equal("Bonk");
      expect(await token.decimals()).to.equal(5);
      expect(await token.sourceChain()).to.equal("solana");
      expect(await token.sourceToken()).to.equal(BONK);
      expect(await token.logoURI()).to.equal("https://arweave.net/bonk.png");
      expect(await gw.mirrorCount()).to.equal(1);
    });

    it("is relayer-only and one mirror per source token", async () => {
      await expect(gw.connect(alice).launch("X", "X", "X", 6, "")).to.be.revertedWithCustomError(gw, "NotRelayer");
      await expect(gw.connect(relayer).launch(BONK, "B", "B", 5, "")).to.be.revertedWithCustomError(gw, "AlreadyLaunched");
      await expect(gw.connect(alice).requestLaunch(BONK)).to.be.revertedWithCustomError(gw, "AlreadyLaunched");
      await expect(gw.connect(alice).requestLaunch("WIF")).to.emit(gw, "LaunchRequested").withArgs("WIF", alice.address);
    });

    it("only the gateway can mint", async () => {
      await expect(token.connect(alice).mint(alice, 1)).to.be.revertedWithCustomError(token, "OnlyGateway");
    });
  });

  describe("buy", () => {
    it("escrows USDC, then mints on fill", async () => {
      const d = await deadline();
      await expect(gw.connect(alice).buy(token, usdc(100), bonk(1_000_000), d))
        .to.emit(gw, "BuyRequested")
        .withArgs(1, alice.address, await token.getAddress(), BONK, usdc(99), bonk(1_000_000), d);
      expect(await gw.escrowedQuote()).to.equal(usdc(100));
      expect(await gw.availableLiquidity()).to.equal(0);

      await expect(gw.connect(relayer).fulfillBuy(1, bonk(1_200_000), "solSig1"))
        .to.emit(gw, "BuyFilled")
        .withArgs(1, bonk(1_200_000), "solSig1");

      expect(await token.balanceOf(alice)).to.equal(bonk(1_200_000));
      expect(await gw.escrowedQuote()).to.equal(0);
      expect(await gw.accruedFees()).to.equal(usdc(1));
      expect(await gw.availableLiquidity()).to.equal(usdc(99));
    });

    it("rejects fills below minOut and double fills", async () => {
      await gw.connect(alice).buy(token, usdc(100), bonk(1_000_000), await deadline());
      await expect(gw.connect(relayer).fulfillBuy(1, bonk(999_999), "x")).to.be.revertedWithCustomError(gw, "Slippage");
      await expect(gw.connect(alice).fulfillBuy(1, bonk(1_000_000), "x")).to.be.revertedWithCustomError(gw, "NotRelayer");
      await gw.connect(relayer).fulfillBuy(1, bonk(1_000_000), "x");
      await expect(gw.connect(relayer).fulfillBuy(1, bonk(1_000_000), "x")).to.be.revertedWithCustomError(gw, "NotPending");
    });

    it("refunds the full amount on reject or expiry", async () => {
      await gw.connect(alice).buy(token, usdc(100), 1, await deadline());
      await gw.connect(alice).buy(token, usdc(50), 1, await deadline());
      const before = await quote.balanceOf(alice);

      await gw.connect(relayer).reject(1, "quote below minOut");
      expect(await quote.balanceOf(alice)).to.equal(before + usdc(100));

      await expect(gw.connect(alice).cancel(2)).to.be.revertedWithCustomError(gw, "NotAllowed");
      await time.increase(601);
      await expect(gw.connect(bob).cancel(2)).to.be.revertedWithCustomError(gw, "NotAllowed");
      await gw.connect(alice).cancel(2);
      expect(await quote.balanceOf(alice)).to.equal(before + usdc(150));
      expect(await gw.escrowedQuote()).to.equal(0);
    });

    it("validates inputs", async () => {
      await expect(gw.connect(alice).buy(quote, usdc(1), 1, await deadline())).to.be.revertedWithCustomError(gw, "UnknownToken");
      await expect(gw.connect(alice).buy(token, 0, 1, await deadline())).to.be.revertedWithCustomError(gw, "BadAmount");
      await expect(gw.connect(alice).buy(token, usdc(1), 1, await deadline(10))).to.be.revertedWithCustomError(gw, "BadDeadline");
    });
  });

  describe("sell", () => {
    beforeEach(async () => {
      await gw.connect(alice).buy(token, usdc(100), 1, await deadline());
      await gw.connect(relayer).fulfillBuy(1, bonk(1_000_000), "buySig");
      await token.connect(alice).approve(gw, ethers.MaxUint256);
    });

    it("escrows tokens, then burns and pays USDC on fill", async () => {
      await gw.connect(alice).sell(token, bonk(500_000), usdc(40), await deadline());
      expect(await token.balanceOf(gw)).to.equal(bonk(500_000));

      const before = await quote.balanceOf(alice);
      await expect(gw.connect(relayer).fulfillSell(2, usdc(50), "sellSig"))
        .to.emit(gw, "SellFilled")
        .withArgs(2, usdc(49.5), usdc(0.5), "sellSig");

      expect(await quote.balanceOf(alice)).to.equal(before + usdc(49.5));
      expect(await token.totalSupply()).to.equal(bonk(500_000));
      expect(await token.balanceOf(gw)).to.equal(0);
    });

    it("enforces minOut on the net amount", async () => {
      await gw.connect(alice).sell(token, bonk(500_000), usdc(50), await deadline());
      await expect(gw.connect(relayer).fulfillSell(2, usdc(50), "x")).to.be.revertedWithCustomError(gw, "Slippage");
    });

    it("never pays out escrowed buys or fees", async () => {
      // 99 USDC liquidity from the first buy; bob's pending buy must stay untouched.
      await gw.connect(bob).buy(token, usdc(1_000), 1, await deadline());
      await gw.connect(alice).sell(token, bonk(1_000_000), 1, await deadline());
      await expect(gw.connect(relayer).fulfillSell(3, usdc(200), "x")).to.be.revertedWithCustomError(gw, "InsufficientLiquidity");

      await gw.connect(owner).depositLiquidity(usdc(500));
      await gw.connect(relayer).fulfillSell(3, usdc(200), "x");
      expect(await gw.escrowedQuote()).to.equal(usdc(1_000));
    });

    it("returns tokens on reject", async () => {
      await gw.connect(alice).sell(token, bonk(500_000), 1, await deadline());
      await gw.connect(relayer).reject(2, "jupiter route failed");
      expect(await token.balanceOf(alice)).to.equal(bonk(1_000_000));
    });
  });

  describe("admin", () => {
    it("owner controls fees, liquidity, relayer and pause", async () => {
      await expect(gw.connect(alice).setFeeBps(10)).to.be.revertedWithCustomError(gw, "OwnableUnauthorizedAccount");
      await expect(gw.setFeeBps(501)).to.be.revertedWithCustomError(gw, "BadFee");

      await gw.connect(alice).buy(token, usdc(100), 1, await deadline());
      await gw.connect(relayer).fulfillBuy(1, 1, "x");
      await expect(gw.withdrawLiquidity(owner, usdc(100))).to.be.revertedWithCustomError(gw, "InsufficientLiquidity");
      await gw.withdrawLiquidity(bob, usdc(99));
      await gw.withdrawFees(bob);
      expect(await quote.balanceOf(bob)).to.equal(usdc(10_100));

      await gw.pause();
      await expect(gw.connect(alice).buy(token, usdc(1), 1, await deadline())).to.be.revertedWithCustomError(gw, "EnforcedPause");
      await gw.setRelayer(bob);
      await gw.unpause();
      await gw.connect(alice).buy(token, usdc(1), 1, await deadline());
      await gw.connect(bob).fulfillBuy(2, 1, "x");
    });
  });
});
