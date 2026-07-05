// Non-negotiable, every page: this is a devnet demonstration, not real money.
export function Banner() {
  return (
    <div className="banner" role="alert">
      <div className="wrap">
        <span className="dot" aria-hidden />
        <span>
          <b>Devnet demonstration.</b> Test tokens only — no real money, no real value, not a licensed gambling product.
          Wallets connect to Solana <b>devnet</b>.
        </span>
      </div>
    </div>
  );
}
