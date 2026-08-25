/**
 * The probe.
 *
 * For a token pair, walk a ladder of trade sizes and record the smallest size the
 * router will quote. Two things make this more informative than a yes/no:
 *
 *   1. Liquidity is directional. A pair can quote one way and not the other, so
 *      each direction is probed separately and reported separately.
 *   2. Gas is charged as a flat USD amount, so it dominates small trades. A quote
 *      that exists at $1 may still be worthless to a user. Every result carries
 *      gas as a percentage of notional so a "yes" that costs 100% is visible.
 */

import { fetchQuote } from './api.js';

export const DEFAULT_RUNGS = [1, 10, 100, 1000, 10000];

/** Scale a human amount to the token's raw integer units, without floating point drift. */
export function toRaw(amount, decimals) {
  const s = String(amount);
  if (!/^\d+(\.\d+)?$/.test(s)) throw new TypeError(`amount must be a non-negative decimal, got ${s}`);
  const [whole, frac = ''] = s.split('.');
  const padded = (frac + '0'.repeat(decimals)).slice(0, decimals);
  const combined = `${whole}${padded}`.replace(/^0+(?=\d)/, '');
  return BigInt(combined).toString();
}

/** Convert raw integer units back to a human number. */
export function fromRaw(raw, decimals) {
  return Number(BigInt(raw)) / 10 ** decimals;
}

/** Group tokens by their ISO currency. The registry carries `currency`, so nothing is hardcoded. */
export function groupByCurrency(tokens) {
  const out = {};
  for (const t of tokens) {
    if (!t.currency) continue;
    (out[t.currency] ||= []).push(t);
  }
  for (const list of Object.values(out)) list.sort((a, b) => a.symbol.localeCompare(b.symbol));
  return out;
}

/** Which base symbols trade against a given quote symbol, per the markets list. */
export function counterpartsOf(markets, quoteSymbol) {
  const set = new Set();
  for (const m of markets) {
    if (m.quote_symbol === quoteSymbol) set.add(m.base_symbol);
    if (m.base_symbol === quoteSymbol) set.add(m.quote_symbol);
  }
  set.delete(quoteSymbol);
  return [...set];
}

/**
 * Probe one direction. Returns the first rung that quotes, or a null result if none do.
 * Stops climbing on the first success: the question is "what is the entry size", not
 * "how deep does it go".
 */
export async function probeDirection(from, to, { rungs = DEFAULT_RUNGS, delayMs = 120, ...opts } = {}) {
  const attempts = [];
  for (const amount of rungs) {
    const fromAmountRaw = toRaw(amount, from.decimals);
    let r;
    try {
      r = await fetchQuote({ fromToken: from.address, toToken: to.address, fromAmountRaw }, opts);
    } catch (err) {
      attempts.push({ amount, error: err.message });
      continue;
    }
    attempts.push({ amount, quoted: r.quoted });
    if (r.quoted) {
      const out = fromRaw(r.minOutputRaw, to.decimals);
      return {
        from: from.symbol, to: to.symbol,
        fromCurrency: from.currency, toCurrency: to.currency,
        quoted: true,
        minSize: amount,
        outAmount: out,
        impliedRate: out / amount,
        gasCostUsd: r.gasCostUsd,
        gasPctOfNotional: r.gasCostUsd != null ? (r.gasCostUsd / amount) * 100 : null,
        legCount: r.legCount,
        attempts,
      };
    }
    if (delayMs) await sleep(delayMs);
  }
  return {
    from: from.symbol, to: to.symbol,
    fromCurrency: from.currency, toCurrency: to.currency,
    quoted: false, minSize: null, outAmount: null, impliedRate: null,
    gasCostUsd: null, gasPctOfNotional: null, legCount: null,
    attempts,
  };
}

/** Probe both directions of a pair. */
export async function probePair(a, b, opts = {}) {
  const forward = await probeDirection(a, b, opts);
  const reverse = await probeDirection(b, a, opts);
  return { forward, reverse, oneWay: forward.quoted !== reverse.quoted };
}

export function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

/**
 * Summarise a set of direction results into the answer people actually want:
 * per ISO currency, which token (if any) is reachable, and at what size.
 */
export function summariseByCurrency(results) {
  const byCurrency = {};
  for (const r of results) {
    const cur = r.toCurrency || r.fromCurrency;
    const entry = (byCurrency[cur] ||= { currency: cur, candidates: [], reachable: [] });
    if (!entry.candidates.includes(r.to)) entry.candidates.push(r.to);
    if (r.quoted) entry.reachable.push({ symbol: r.to, minSize: r.minSize, impliedRate: r.impliedRate, gasPctOfNotional: r.gasPctOfNotional });
  }
  for (const e of Object.values(byCurrency)) {
    e.reachable.sort((x, y) => x.minSize - y.minSize);
    e.canonical = e.reachable.length ? e.reachable[0].symbol : null;
  }
  return byCurrency;
}
