# sera-liquidity-probe

**A keyless measurement tool for Sera's router: send a ladder of quote sizes and see what
the venue answers, at every size, in whichever direction you ask.**

It is a measuring instrument, not a report. It ships no findings and no cached numbers —
you point it at the live API and it tells you what the API said, when it said it.

Everything it does is a read. Nothing is signed, nothing is submitted, no funds move, and
no API key is involved.

## The correction that reshaped this tool

An early version of this probe measured quotes without sending `gas_mode`, and I published
a conclusion drawn from those numbers. **That conclusion was wrong, and it was wrong
because of a parameter I had not read.**

`POST /swap/quote` takes `gas_mode`, documented at
[docs.sera.cx/swaps](https://docs.sera.cx/swaps/). It defaults to `receive_less`, which
deducts the flat gas component from your **output**. Compute a rate by dividing output by
input in that mode and you have not measured a rate — you have measured a rate blended
with a fixed cost, and a fixed cost is a larger fraction of a small amount than a large
one, so the result appears to move with size even when the rate does not.

Send `pay_more` instead — the flat cost is added to the input rather than netted out of
the output — and `USDC -> MYRT` answers **4.013693** at $1, **4.013695** at $10 and
**4.013695** at $100. The same rate to six figures across two orders of magnitude.
`USDC -> XSGD` behaves identically: 1.265798 at $1, 1.265799 at $100. Measured live,
28 August 2026.

So the probe now sends `gas_mode` explicitly, defaults to `pay_more`, and prints the mode
in its output, because a number measured in one mode is not comparable with a number
measured in the other.

**Read the request schema before you interpret the response.** Two careful passes on top
of one unread parameter produced a confident, reproducible, wrong conclusion — and the
reproducibility made it feel more true rather than less.

## Why no key

The core API splits cleanly:

| Endpoint | Auth |
|---|---|
| `GET /tokens`, `GET /markets`, `GET /config`, `GET /health` | public |
| `POST /swap/quote` | **public** |
| `GET /orders`, `/fills`, `/balances` | API key, minted with a wallet via EIP-712 |

The router will price a swap for anyone. That is what makes measurement from outside
possible at all, and it is a deliberate and unusually open posture for a venue to take.

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
PAIR        ISO      MODE      MIN     RATE     COST@100
------------------------------------------------------------
USDC/XSGD   USD/SGD  pay_more   $1   1.265798     1.14%
USDC/MYRT   USD/MYR  pay_more   $1   4.013693     1.14%
```

- **MODE** is the `gas_mode` the quote was requested in. Always shown, never assumed.
- **MIN** is the smallest size on the ladder that returned a price.
- **RATE** is implied from `route_params.minOutputAmount`, so it is the number a taker
  would be guaranteed, not a mid.
- **COST@100** is the all-in cost of a $100 transfer: the 0.14% protocol fee plus the flat
  `fee_breakdown.gas_cost_usd`. It is printed with its notional attached on purpose,
  because a proportional fee plus a flat one is a curve, not a percentage — 1.14% on $100,
  0.24% on $1,000, 0.15% on $10,000. Any single percentage figure for this venue is true
  at exactly one transfer size.

Rows the ladder did not price are printed with the reason the API returned, verbatim and
unedited, so you can see the venue's own answer rather than my summary of it.

## The rate and the cost are two different numbers

This is the tool's whole opinion, and it is the one thing it will argue with you about.

The rate answers "what does this currency cost in that currency". On the corridors
measured so far it is flat across size. The cost answers "what will this transfer cost me",
and it is a curve, because it has a proportional part and a fixed part.

Blend them and you get a number that is neither, and that will look different at every
size for reasons that have nothing to do with the market. The probe reports them in
separate columns and refuses to combine them.

Worth stating the comparison properly while we are here: at 0.14% plus a flat $1.00, a 3%
retail bank conversion is beaten above roughly $35, and the World Bank's 6.36% global
average remittance cost is beaten above roughly $16. Those break-evens are checkable, and
they are more useful than a headline percentage because they say where they stop applying.

## Why the ISO mapping is not hardcoded

Sera's own worker sketch carries this line:

```js
const ISO_TO_TOKEN = { USD: 'USDC', EUR: 'EURC', /* extend from GET /tokens */ };
```

with a note to confirm the canonical pick. It does not need confirming by hand. Every
entry in `GET /tokens` carries an ISO `currency` field, so the grouping is derivable, and
*which* of a currency's tokens is canonical is an empirical question this tool answers:
the canonical token for a currency is whichever one prices at the smallest size on the run
you just did. A hardcoded map is correct on the day it is typed and drifts silently
afterwards; asking is free.

## Use it as a library

```js
import { fetchTokens, fetchMarkets, probeDirection, summariseByCurrency } from 'sera-liquidity-probe';

const tokens = await fetchTokens();
const bySymbol = Object.fromEntries(tokens.map(t => [t.symbol, t]));

const r = await probeDirection(bySymbol.USDC, bySymbol.XSGD, { rungs: [1, 10, 100], gasMode: 'pay_more' });
// { quoted: true, minSize: 1, impliedRate: 1.265798, gasMode: 'pay_more', flatGasUsd: 1, protocolFeePct: 0.14, ... }
```

`--json` emits the same structure for pipelines.

## Options

```
--hub SYMBOL        settlement token to probe against (default USDC)
--currencies LIST   restrict to ISO codes, e.g. EUR,GBP,SGD
--rungs LIST        trade sizes to try (default 1,10,100,1000,10000)
--max-rungs N       use only the first N rungs
--gas-mode MODE     pay_more (default) or receive_less
--delay MS          pause between requests (default 120)
--json              machine-readable output
--base URL          override the API base
```

## Design notes

**A rate is directional.** A quote answers a directed question, and inverting one assumes
a symmetry the quote never asserted. The probe measures each direction separately and
reports each on its own line. It will not invert.

**The API's own responses are passed through, not summarised.** Whatever reason the
endpoint gives for a request it does not price is reported verbatim as a result, and only
genuine transport and client failures throw. A caller must be able to tell a case it
should handle from a case it should page someone about.

**Integer maths throughout.** Amounts are scaled with `BigInt`, never
`amount * 10 ** decimals`, which loses precision above 2^53 and quietly mis-scales
18-decimal tokens.

**Both legs of every market.** Counting markets by one leg undercounts the book — it is
how a first pass here counted 27 when the honest either-leg number was 39, missing `USDT`.
When you publish a count, publish the predicate with it.

**It stops climbing at the first price.** The question is the entry size, not the depth.
Probing further would mean more load on a public endpoint for an answer nobody asked for.

**Nothing is cached and nothing is claimed.** Every number in this README that came from
the API is dated. Re-run the probe before quoting any of it; the book moves, and a
measurement with no timestamp is an assertion.

## Tests

18 tests, no network, driven by response bodies captured from the live API and checked in
under `test/fixtures/`. They cover the scaling maths, the request shape the API requires
including `gas_mode`, the pass-through rule for non-pricing responses, ladder-climbing,
the fee-plus-flat-gas cost curve, and the currency summary. CI runs them on Node 18, 20
and 22.

Related: [sera-fx-rates](https://github.com/0xmintmee/sera-fx-rates) is the rates layer
built on top of what this tool measures.

## Licence

MIT
