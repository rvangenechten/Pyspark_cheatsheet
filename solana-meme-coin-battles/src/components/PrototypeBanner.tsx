export function PrototypeBanner() {
  return (
    <div className="bg-brand/10 border-b border-brand/30 text-center text-xs sm:text-sm py-2 px-4 text-mist">
      <span className="font-semibold text-white">Devnet prototype.</span> No real funds ever
      move — wagers are demo bookkeeping signed with throwaway devnet SOL. See{' '}
      <a href="#/README" className="underline decoration-dotted hover:text-white">
        the README
      </a>{' '}
      for what a real-money version would require (audited on-chain vault, an oracle, and
      likely a money-transmission / gambling license review).
    </div>
  )
}
