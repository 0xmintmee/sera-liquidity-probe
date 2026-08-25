import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { toRaw, fromRaw, groupByCurrency, counterpartsOf, probeDirection, summariseByCurrency } from '../src/probe.js';
import { fetchQuote, fetchTokens, isNoLiquidity, SeraApiError } from '../src/api.js';
import { formatRate, renderTable } from '../src/format.js';

const here = dirname(fileURLToPath(import.meta.url));
const fx = (n) => JSON.parse(readFileSync(join(here, 'fixtures', n), 'utf8'));

const TOKENS = fx('tokens.json').tokens;
const MARKETS = fx('markets.json').markets;
const QUOTE_OK = fx('quote-ok.json');
const QUOTE_NOLIQ = fx('quote-noliq.json');

const bySym = Object.fromEntries(TOKENS.map((t) => [t.symbol, t]));

/** Minimal fetch double. Responses are the real bodies captured from the live API. */
function stubFetch(plan) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url, body: init && init.body ? JSON.parse(init.body) : null });
    const step = plan.shift();
    if (!step) throw new Error('stubFetch: ran out of planned responses');
    return {
      ok: step.status < 400,
      status: step.status,
      text: async () => JSON.stringify(step.body),
    };
  };
  impl.calls = calls;
  return impl;
}

test('toRaw scales without floating point drift', () => {
  assert.equal(toRaw(1, 6), '1000000');
  assert.equal(toRaw(10, 6), '10000000');
  assert.equal(toRaw('0.1', 6), '100000');
  assert.equal(toRaw(1, 18), '1000000000000000000');
  // the case that breaks a naive amount * 10 ** decimals
  assert.equal(toRaw('1234567.123456', 18), '1234567123456000000000000');
});

test('toRaw rejects nonsense', () => {
  assert.throws(() => toRaw('-1', 6), TypeError);
  assert.throws(() => toRaw('abc', 6), TypeError);
});

test('fromRaw inverts toRaw for representable values', () => {
  assert.equal(fromRaw(toRaw('12.5', 6), 6), 12.5);
});

test('groupByCurrency uses the registry currency field, so EUR collects every EUR token', () => {
  const g = groupByCurrency(TOKENS);
  assert.deepEqual(g.EUR.map((t) => t.symbol), ['EUR0', 'EURC']);
  assert.deepEqual(g.SGD.map((t) => t.symbol), ['XSGD']);
});

test('counterpartsOf finds everything trading against the hub', () => {
  const c = counterpartsOf(MARKETS, 'USDC').sort();
  assert.deepEqual(c, ['EUR0', 'EURC', 'XSGD']);
  assert.ok(!c.includes('USDC'), 'the hub is not its own counterpart');
});

test('a no_liquidity 400 is a real answer, not an error', async () => {
  const fetchImpl = stubFetch([{ status: 400, body: QUOTE_NOLIQ }]);
  const r = await fetchQuote(
    { fromToken: bySym.USDC.address, toToken: bySym.EURC.address, fromAmountRaw: '1000000' },
    { fetchImpl },
  );
  assert.equal(r.quoted, false);
  assert.equal(r.reason, 'no_liquidity');
});

test('a genuine transport failure still throws, so a broken deploy is never read as an empty book', async () => {
  const fetchImpl = stubFetch([{ status: 500, body: { detail: 'upstream exploded' } }]);
  await assert.rejects(
    () => fetchQuote({ fromToken: 'a', toToken: 'b', fromAmountRaw: '1' }, { fetchImpl }),
    SeraApiError,
  );
});

test('a successful quote reads minOutputAmount out of route_params', async () => {
  const fetchImpl = stubFetch([{ status: 200, body: QUOTE_OK }]);
  const r = await fetchQuote({ fromToken: 'a', toToken: 'b', fromAmountRaw: '10000000' }, { fetchImpl });
  assert.equal(r.quoted, true);
  assert.equal(r.minOutputRaw, '11372535');
  assert.equal(r.gasCostUsd, 1);
  assert.equal(r.legCount, 1);
});

test('the quote request carries the shape the API actually requires', async () => {
  const fetchImpl = stubFetch([{ status: 200, body: QUOTE_OK }]);
  await fetchQuote({ fromToken: '0xAA', toToken: '0xBB', fromAmountRaw: '5' }, { fetchImpl, now: () => 1_000_000_000_000 });
  const sent = fetchImpl.calls[0].body;
  assert.deepEqual(Object.keys(sent).sort(), ['expiration', 'from_amount', 'from_token', 'owner_address', 'recipient', 'to_token']);
  assert.equal(sent.from_token, '0xaa', 'addresses are lowercased');
  assert.equal(sent.expiration, 1_000_000_000 + 3600);
});

test('probeDirection climbs the ladder and stops at the first size that quotes', async () => {
  const fetchImpl = stubFetch([
    { status: 400, body: QUOTE_NOLIQ },   // $1
    { status: 400, body: QUOTE_NOLIQ },   // $10
    { status: 200, body: QUOTE_OK },      // $100 quotes
  ]);
  const r = await probeDirection(bySym.USDC, bySym.XSGD, { fetchImpl, rungs: [1, 10, 100, 1000], delayMs: 0 });
  assert.equal(r.quoted, true);
  assert.equal(r.minSize, 100);
  assert.equal(r.attempts.length, 3, 'stops climbing once it gets a price');
  assert.equal(r.gasPctOfNotional, 1, '$1 gas on $100 is 1%');
});

test('probeDirection reports an empty book without throwing', async () => {
  const fetchImpl = stubFetch([
    { status: 400, body: QUOTE_NOLIQ },
    { status: 400, body: QUOTE_NOLIQ },
  ]);
  const r = await probeDirection(bySym.USDC, bySym.EURC, { fetchImpl, rungs: [1, 10], delayMs: 0 });
  assert.equal(r.quoted, false);
  assert.equal(r.minSize, null);
  assert.equal(r.impliedRate, null);
});

test('flat gas is surfaced as a share of notional, so a $1 quote costing $1 is visible', async () => {
  const fetchImpl = stubFetch([{ status: 200, body: QUOTE_OK }]);
  const r = await probeDirection(bySym.USDC, bySym.XSGD, { fetchImpl, rungs: [1], delayMs: 0 });
  assert.equal(r.gasPctOfNotional, 100, '$1 gas on a $1 trade is the whole trade');
});

test('summariseByCurrency picks the smallest reachable token per currency', () => {
  const results = [
    { to: 'EURC', toCurrency: 'EUR', quoted: false, minSize: null },
    { to: 'EUR0', toCurrency: 'EUR', quoted: true, minSize: 10, impliedRate: 0.92, gasPctOfNotional: 10 },
    { to: 'XSGD', toCurrency: 'SGD', quoted: true, minSize: 1, impliedRate: 1.13, gasPctOfNotional: 100 },
  ];
  const s = summariseByCurrency(results);
  assert.equal(s.EUR.canonical, 'EUR0');
  assert.equal(s.EUR.candidates.length, 2);
  assert.equal(s.SGD.canonical, 'XSGD');
});

test('summariseByCurrency reports no canonical token when nothing quotes', () => {
  const s = summariseByCurrency([{ to: 'EURC', toCurrency: 'EUR', quoted: false, minSize: null }]);
  assert.equal(s.EUR.canonical, null);
});

test('isNoLiquidity recognises the nested and flat shapes', () => {
  assert.equal(isNoLiquidity(QUOTE_NOLIQ), true);
  assert.equal(isNoLiquidity({ error: 'no_liquidity' }), true);
  assert.equal(isNoLiquidity({ detail: 'something about no_liquidity here' }), true);
  assert.equal(isNoLiquidity({ detail: { error: 'bad_amount' } }), false);
  assert.equal(isNoLiquidity(null), false);
});

test('fetchTokens rejects an unexpected payload rather than returning junk', async () => {
  const fetchImpl = stubFetch([{ status: 200, body: { nope: true } }]);
  await assert.rejects(() => fetchTokens({ fetchImpl }), SeraApiError);
});

test('formatRate keeps precision usable across magnitudes', () => {
  assert.equal(formatRate(null), '-');
  assert.equal(formatRate(1.13725), '1.1373');
  assert.equal(formatRate(1490), '1490.00');
  assert.equal(formatRate(0.000123456), '0.0001235');
});

test('renderTable produces aligned rows with a header', () => {
  const out = renderTable([
    { from: 'USDC', to: 'XSGD', fromCurrency: 'USD', toCurrency: 'SGD', quoted: true, minSize: 1, impliedRate: 1.1373, gasPctOfNotional: 100 },
    { from: 'USDC', to: 'EURC', fromCurrency: 'USD', toCurrency: 'EUR', quoted: false, minSize: null, impliedRate: null, gasPctOfNotional: null },
  ]);
  const lines = out.split('\n');
  assert.match(lines[0], /PAIR/);
  assert.equal(lines.length, 4);
  assert.match(out, /USDC\/XSGD/);
  assert.match(out, /no/);
});
