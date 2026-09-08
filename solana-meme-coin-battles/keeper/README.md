# Keeper

Off-chain process that settles ended `battle_vault` battles on-chain by
calling the program's permissionless `settle_battle` instruction. See the
big comment at the top of `src/index.ts` for exactly what it does.

**Status:** type-checks (`npm run typecheck`), has not been run — it has
nothing to talk to until `/program` is built and deployed (no IDL exists
yet). The frontend simulates the same "check ended battles, settle them"
logic client-side for the demo; this is what replaces that simulation in a
real deployment.

## Running it (once the program is deployed)

```bash
cd program && anchor build   # generates target/idl/battle_vault.json
cd ../keeper
npm install
PROGRAM_ID=<deployed program address> \
KEEPER_KEYPAIR_PATH=~/.config/solana/id.json \
RPC_URL=https://api.devnet.solana.com \
npm start
```

The keeper keypair only ever pays transaction fees — settlement can't send
anyone's stake anywhere except the winner's vault, so there's nothing here
worth protecting beyond normal key hygiene. Anyone could run this; it
doesn't need to be trusted.
