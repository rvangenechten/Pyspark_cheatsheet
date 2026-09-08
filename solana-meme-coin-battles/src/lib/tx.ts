import {
  Connection,
  PublicKey,
  Transaction,
  TransactionInstruction,
} from '@solana/web3.js'
import type { WalletContextState } from '@solana/wallet-adapter-react'

const MEMO_PROGRAM_ID = new PublicKey('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr')

// Meme coins like BONK/WIF don't exist on devnet, so a literal SPL transfer
// of "10,000 BONK" isn't possible without deploying test mints. Instead we
// ask the connected wallet to sign a real devnet memo transaction recording
// the action — a genuine, on-chain, inspectable signature — while the coin
// bookkeeping itself lives in the demo vault (see lib/vault.ts). The Anchor
// program in /program is the sketch of what replaces this in production.
export async function signDemoAction(
  connection: Connection,
  wallet: WalletContextState,
  memo: string,
): Promise<string> {
  if (!wallet.publicKey || !wallet.signTransaction) {
    throw new Error('Wallet not connected')
  }

  const ix = new TransactionInstruction({
    keys: [{ pubkey: wallet.publicKey, isSigner: true, isWritable: true }],
    programId: MEMO_PROGRAM_ID,
    data: Buffer.from(memo, 'utf8'),
  })

  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash()
  const tx = new Transaction({
    feePayer: wallet.publicKey,
    blockhash,
    lastValidBlockHeight,
  }).add(ix)

  const signature = await wallet.sendTransaction(tx, connection)
  await connection.confirmTransaction({ signature, blockhash, lastValidBlockHeight }, 'confirmed')
  return signature
}

export function explorerUrl(signature: string) {
  return `https://explorer.solana.com/tx/${signature}?cluster=devnet`
}
