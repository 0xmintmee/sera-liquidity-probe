# sera-liquidity-probe

**Which Sera FX pairs can actually be quoted, at what size, and what flat gas does to the rate.**

Sera's [FREE-FX-Rates](https://github.com/sera-cx/FREE-FX-Rates-by-Sera.CX) site ships with
`LIVE_RATES_ENABLED = false` and simulated rates. The repo's own notes explain why: the core
API is a signed on-chain orderbook with no public price endpoint and no CORS, so a
server-side rates layer has to exist before the flag can be flipped.

Before you build that layer, you need an answer to a question nobody had written down:
**which pairs will the book actually price, and at what trade size?** A rates API that
serves `no_liquidity` for most of its pairs is worse than a simulated one, because it
looks live.

This tool answers that question, and it needs no API key to do it.

## Why no key

The core API splits cleanly:

| Endpoint | Auth |
|---|---|
| `GET /tokens`, `GET /markets`, `GET /config`, `GET /health` | public |
| `POST /swap/quote` | **public** |
| `GET /orders`, `/fills`, `/balances` | API key, minted with a wallet via EIP-712 |

The orderbook itself is gated, but the router will price a swap for anyone. Asking for a
quote is a read: nothing is signed, nothing is submitted, no funds move, and the quote
expires on its own. So the book's *effective* liquidity can be measured from outside.

## Install and run

```bash
npx sera-liquidity-probe
```

Or from a clone:

```bash
npm test          # 18 offline tests, no network
npm run probe     # live probe against api.sera.cx
```

## What it prints

```
PAIR        ISO      QUOTED   MIN     RATE    GAS
--------------------------------------------------
USDC/XSGD   USD/SGD  yes       $1   1.1373  100.0%
USDC/EURC   USD/EUR  no         -        -       -
USDC/EUR0   USD/EUR  no         -        -       -
...
```

- **MIN** is the smallest size on the ladder that got a price. Nothing below it quotes.
- **RATE** is implied from `route_params.minOutputAmount`, so it is the number a taker
  would actually be guaranteed, not a mid.
- **GAS** is `fee_breakdown.gas_cost_usd` as a share of the trade. Gas is charged as a flat
  USD amount, so a quote that exists at $1 can still cost 100% of the trade to fill. A
  pair being quotable and a pair being usable are different questions, and the column
  keeps them apart.

## What it found, 23 August 2026

Run against the live API on that date, probing every token trading against USDC at
$1 / $10 / $100 / $1,000:

- **3 of 39 markets returned a quote at any size** (`MYRT`, `XSGD`, `USDT`). One of the
  three is USD against USD, so **two cross-currency corridors priced**.
- The registry lists **40 tokens across 22 ISO currencies**. **EUR alone has ten**
  (`EUR0, EURAU, EURC, EURE, EURI, EUROP, EURQ, EURR, EURS, VEUR`). All ten have a USDC
  market. None of the ten quoted, at any size.
- **Liquidity is directional.** `USDC -> MYRT` quoted at $1, $10 and $100.
  `MYRT -> USDC` returned `no_liquidity` at every size. A rates layer that assumes a
  pair is symmetric will publish a rate it cannot honour in one direction.
- Flat gas was **$1.00** on every quote returned, which is 100% of a $1 trade and 1% of
  a $100 one.

Re-run it before quoting any of this; the book moves.

**A note on that denominator, because it caught me.** A first pass counted 27 markets by
filtering `quote_symbol === 'USDC'`. That is wrong: USDC is the *base* in twelve more
markets, so the honest either-leg count is 39, and `USDT` — one of the three that
actually priced — sits in the twelve the narrow filter missed. `counterpartsOf()` in
`src/probe.js` filters both legs for exactly this reason. If you are counting a
population rather than a filter, count both sides or you will publish a number that is
smaller than the truth and impossible for anyone else to reproduce.

## Why the ISO mapping is not hardcoded

Sera's own worker sketch carries this line:

```js
const ISO_TO_TOKEN = { USD: 'USDC', EUR: 'EURC', /* extend from GET /tokens */ };
```

with a note to confirm the canonical pick, `EURC` vs `EUR0`. It does not need confirming
by hand. Every entry in `GET /tokens` already carries an ISO `currency` field, so the
grouping is derivable, and *which* of a currency's ten tokens is canonical is an empirical
question this tool answers: the canonical token for a currency is the one that quotes at
the smallest size. When none of them quote, the honest answer is `null`, and that is what
gets reported.

## Use it as a library

```js
import { fetchTokens, fetchMarkets, probeDirection, summariseByCurrency } from 'sera-liquidity-probe';

const tokens = await fetchTokens();
const bySymbol = Object.fromEntries(tokens.map(t => [t.symbol, t]));

const r = await probeDirection(bySymbol.USDC, bySymbol.XSGD, { rungs: [1, 10, 100] });
// { quoted: true, minSize: 1, impliedRate: 1.1373, gasPctOfNotional: 100, ... }
```

`--json` emits the same structure for pipelines.

## Options

```
--hub SYMBOL        settlement token to probe against (default USDC)
--currencies LIST   restrict to ISO codes, e.g. EUR,GBP,SGD
--rungs LIST        trade sizes to try (default 1,10,100,1000,10000)
--max-rungs N       use only the first N rungs
--delay MS          pause between requests (default 120)
--json              machine-readable output
--base URL          override the API base
```

## Design notes

**A `no_liquidity` response is data, not an error.** The API returns it as HTTP 400 with
`{ detail: { success: false, error: 'no_liquidity' } }`. The client returns that as a
result; anything else that fails throws. A broken deploy must never be readable as an
empty book, and an empty book must never look like a crash.

**Integer maths throughout.** Amounts are scaled with `BigInt`, never
`amount * 10 ** decimals`, which loses precision above 2^53 and quietly mis-scales
18-decimal tokens.

**It stops climbing at the first price.** The question is the entry size, not the depth.
Probing further would mean more load on a public endpoint for an answer nobody asked for.

## Tests

18 tests, no network, driven by response bodies captured from the live API and checked in
under `test/fixtures/`. They cover the scaling maths, the request shape the API actually
requires, the `no_liquidity`-is-not-an-error rule, ladder-climbing, gas-as-percentage, and
the currency summary. CI runs them on Node 18, 20 and 22.

## Licence

MIT
