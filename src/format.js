/** Rendering. Kept apart from probing so the data can be consumed without the prose. */

const pad = (s, n) => String(s).padEnd(n);
const padL = (s, n) => String(s).padStart(n);

export function formatRate(n) {
  if (n == null) return '-';
  if (n >= 1000) return n.toFixed(2);
  if (n >= 1) return n.toFixed(4);
  return n.toPrecision(4);
}

export function renderTable(results) {
  const rows = results.map((r) => ({
    pair: `${r.from}/${r.to}`,
    cur: `${r.fromCurrency || '?'}/${r.toCurrency || '?'}`,
    quoted: r.quoted ? 'yes' : 'no',
    size: r.minSize == null ? '-' : `$${r.minSize}`,
    rate: formatRate(r.impliedRate),
    gas: r.gasPctOfNotional == null ? '-' : `${r.gasPctOfNotional.toFixed(1)}%`,
  }));
  const w = {
    pair: Math.max(4, ...rows.map((r) => r.pair.length)),
    cur: Math.max(3, ...rows.map((r) => r.cur.length)),
    quoted: 6, size: Math.max(4, ...rows.map((r) => r.size.length)),
    rate: Math.max(4, ...rows.map((r) => r.rate.length)),
    gas: Math.max(3, ...rows.map((r) => r.gas.length)),
  };
  const line = [
    pad('PAIR', w.pair), pad('ISO', w.cur), pad('QUOTED', w.quoted),
    padL('MIN', w.size), padL('RATE', w.rate), padL('GAS', w.gas),
  ].join('  ');
  const sep = '-'.repeat(line.length);
  const body = rows.map((r) => [
    pad(r.pair, w.pair), pad(r.cur, w.cur), pad(r.quoted, w.quoted),
    padL(r.size, w.size), padL(r.rate, w.rate), padL(r.gas, w.gas),
  ].join('  '));
  return [line, sep, ...body].join('\n');
}

export function renderSummary(results, summary) {
  const quoted = results.filter((r) => r.quoted);
  const lines = [];
  lines.push('');
  lines.push(`${quoted.length} of ${results.length} directions returned a quote.`);

  const currencies = Object.values(summary);
  const reachable = currencies.filter((c) => c.canonical);
  lines.push(`${reachable.length} of ${currencies.length} currencies are reachable at any size on the ladder.`);

  const multi = currencies.filter((c) => c.candidates.length > 1);
  if (multi.length) {
    lines.push('');
    lines.push('Currencies with more than one token, and which one actually quotes:');
    for (const c of multi) {
      lines.push(`  ${c.currency}: ${c.candidates.length} tokens (${c.candidates.join(', ')}) -> ${c.canonical || 'none reachable'}`);
    }
  }

  const dear = quoted.filter((r) => r.gasPctOfNotional != null && r.gasPctOfNotional >= 1);
  if (dear.length) {
    lines.push('');
    lines.push('Quotes where flat gas is 1% or more of the trade:');
    for (const r of dear) {
      lines.push(`  ${r.from}/${r.to} at $${r.minSize}: gas $${r.gasCostUsd} = ${r.gasPctOfNotional.toFixed(1)}% of notional`);
    }
  }
  return lines.join('\n');
}
