#!/usr/bin/env node
/**
 * sera-liquidity-probe
 *
 * Measures what Sera's book will actually quote, using only public endpoints.
 * No API key. Nothing is signed, nothing is submitted, no funds move: a quote
 * request is a read.
 */

import { fetchTokens, fetchMarkets, DEFAULT_BASE } from './api.js';
import { probeDirection, groupByCurrency, counterpartsOf, summariseByCurrency, DEFAULT_RUNGS } from './probe.js';
import { renderTable, renderSummary } from './format.js';

function parseArgs(argv) {
  const o = { hub: 'USDC', json: false, rungs: DEFAULT_RUNGS, delayMs: 120, base: DEFAULT_BASE, currencies: null, maxRungs: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === '--hub') o.hub = next().toUpperCase();
    else if (a === '--json') o.json = true;
    else if (a === '--delay') o.delayMs = Number(next());
    else if (a === '--base') o.base = next();
    else if (a === '--currencies') o.currencies = next().split(',').map((s) => s.trim().toUpperCase());
    else if (a === '--rungs') o.rungs = next().split(',').map(Number);
    else if (a === '--max-rungs') o.maxRungs = Number(next());
    else if (a === '--help' || a === '-h') o.help = true;
    else { console.error(`unknown flag: ${a}`); process.exit(2); }
  }
  if (o.maxRungs) o.rungs = o.rungs.slice(0, o.maxRungs);
  return o;
}

const HELP = `sera-liquidity-probe

  Which Sera FX pairs can actually be quoted, at what size, and what flat gas
  does to the effective rate. Public endpoints only, no API key.

Usage
  npx sera-liquidity-probe [options]

Options
  --hub SYMBOL        settlement token to probe against (default USDC)
  --currencies LIST   restrict to ISO codes, e.g. EUR,GBP,SGD
  --rungs LIST        trade sizes to try, in hub units (default ${DEFAULT_RUNGS.join(',')})
  --max-rungs N       use only the first N rungs
  --delay MS          pause between requests (default 120)
  --json              emit machine-readable JSON instead of a table
  --base URL          override the API base
  -h, --help          this text
`;

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) { console.log(HELP); return; }

  const net = { base: opts.base };
  const [tokens, markets] = await Promise.all([fetchTokens(net), fetchMarkets(net)]);

  const bySymbol = Object.fromEntries(tokens.map((t) => [t.symbol, t]));
  const hub = bySymbol[opts.hub];
  if (!hub) {
    console.error(`hub token ${opts.hub} not found. Available: ${tokens.map((t) => t.symbol).join(', ')}`);
    process.exit(1);
  }

  let counterparts = counterpartsOf(markets, opts.hub).map((s) => bySymbol[s]).filter(Boolean);
  if (opts.currencies) counterparts = counterparts.filter((t) => opts.currencies.includes(t.currency));

  if (!opts.json) {
    console.error(`Probing ${counterparts.length} tokens against ${hub.symbol} at sizes ${opts.rungs.join(', ')}...`);
    console.error('(a "no" means the router declined to price it, not that the tool failed)\n');
  }

  const results = [];
  for (const t of counterparts) {
    const r = await probeDirection(hub, t, { ...net, rungs: opts.rungs, delayMs: opts.delayMs });
    results.push(r);
    if (!opts.json) process.stderr.write(r.quoted ? '.' : 'x');
  }
  if (!opts.json) process.stderr.write('\n\n');

  const summary = summariseByCurrency(results);
  const grouped = groupByCurrency(tokens);
  for (const [cur, list] of Object.entries(grouped)) {
    if (summary[cur]) summary[cur].allTokens = list.map((t) => t.symbol);
  }

  if (opts.json) {
    console.log(JSON.stringify({
      asOf: new Date().toISOString(),
      hub: hub.symbol,
      rungs: opts.rungs,
      results,
      summary,
    }, null, 2));
  } else {
    console.log(renderTable(results));
    console.log(renderSummary(results, summary));
  }
}

main().catch((err) => {
  console.error(`\n${err.name || 'Error'}: ${err.message}`);
  if (err.body) console.error(typeof err.body === 'string' ? err.body.slice(0, 300) : JSON.stringify(err.body).slice(0, 300));
  process.exit(1);
});
