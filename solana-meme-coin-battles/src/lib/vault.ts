export type VaultState = Record<string, Record<string, number>> // wallet -> coinId -> amount

export function balanceOf(vault: VaultState, wallet: string | undefined, coinId: string): number {
  if (!wallet) return 0
  return vault[wallet]?.[coinId] ?? 0
}

export function deposit(
  vault: VaultState,
  wallet: string,
  coinId: string,
  amount: number,
): VaultState {
  const walletVault = vault[wallet] ?? {}
  return {
    ...vault,
    [wallet]: { ...walletVault, [coinId]: (walletVault[coinId] ?? 0) + amount },
  }
}

export function withdraw(
  vault: VaultState,
  wallet: string,
  coinId: string,
  amount: number,
): VaultState {
  const walletVault = vault[wallet] ?? {}
  const next = Math.max(0, (walletVault[coinId] ?? 0) - amount)
  return { ...vault, [wallet]: { ...walletVault, [coinId]: next } }
}
