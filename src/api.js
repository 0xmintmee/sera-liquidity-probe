/**
 * Thin client for the three PUBLIC endpoints on Sera's core API.
 *
 * No API key is required for any of these. That is the whole point of this tool:
 * the authenticated orderbook endpoints (/orders, /fills, /balances) need a key
 * minted with a wallet, but /tokens, /markets and POST /swap/quote do not, so
 * anyone can measure what the book will actually quote without credentials.
 */

export const DEFAULT_BASE = 'https://api.sera.cx/api/v1';

/** Address used as taker/recipient when asking for a price we never intend to fill. */
export const PROBE_ADDRESS = '0x0000000000000000000000000000000000000001';

export class SeraApiError extends Error {
  constructor(message, { status, body } = {}) {
    super(message);
    this.name = 'SeraApiError';
    this.status = status;
    this.body = body;
  }
}

async function getJson(url, { fetchImpl = fetch, timeoutMs = 15000 } = {}) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, { signal: ctl.signal });
    const text = await res.text();
    let body;
    try { body = JSON.parse(text); } catch { body = text; }
    if (!res.ok) throw new SeraApiError(`GET ${url} failed`, { status: res.status, body });
    return body;
  } finally {
    clearTimeout(timer);
  }
}

/** All tokens. Each carries an ISO `currency`, so the ISO mapping never needs hand-maintaining. */
export async function fetchTokens(opts = {}) {
  const base = opts.base || DEFAULT_BASE;
  const { tokens } = await getJson(`${base}/tokens`, opts);
  if (!Array.isArray(tokens)) throw new SeraApiError('unexpected /tokens shape', { body: tokens });
  return tokens;
}

/** All markets, as base/quote symbol pairs. */
export async function fetchMarkets(opts = {}) {
  const base = opts.base || DEFAULT_BASE;
  const { markets } = await getJson(`${base}/markets`, opts);
  if (!Array.isArray(markets)) throw new SeraApiError('unexpected /markets shape', { body: markets });
  return markets;
}

/**
 * Ask the router for a quote. Public, keyless.
 *
 * Returns one of:
 *   { quoted: true,  minOutputRaw, gasCostUsd, legCount, expiresAt }
 *   { quoted: false, reason: 'no_liquidity' }
 *
 * A `no_liquidity` answer arrives as HTTP 400 with
 * { detail: { success:false, error:'no_liquidity' } }. That is a real answer about
 * the book, not a transport failure, so it is returned rather than thrown. Anything
 * else that fails is thrown, so a broken deploy never masquerades as an empty book.
 */
export async function fetchQuote({ fromToken, toToken, fromAmountRaw }, opts = {}) {
  const base = opts.base || DEFAULT_BASE;
  const fetchImpl = opts.fetchImpl || fetch;
  const now = opts.now ? opts.now() : Date.now();

  const res = await fetchImpl(`${base}/swap/quote`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from_token: String(fromToken).toLowerCase(),
      to_token: String(toToken).toLowerCase(),
      from_amount: String(fromAmountRaw),
      owner_address: PROBE_ADDRESS,
      recipient: PROBE_ADDRESS,
      expiration: Math.floor(now / 1000) + 3600,
    }),
  });

  const text = await res.text();
  let body;
  try { body = JSON.parse(text); } catch { body = text; }

  if (!res.ok) {
    if (isNoLiquidity(body)) return { quoted: false, reason: 'no_liquidity' };
    throw new SeraApiError(`POST /swap/quote failed`, { status: res.status, body });
  }
  if (body && body.no_liquidity) return { quoted: false, reason: 'no_liquidity' };

  const rp = body && body.route_params;
  if (!rp || rp.minOutputAmount == null) {
    throw new SeraApiError('quote succeeded but carried no route_params.minOutputAmount', { body });
  }

  return {
    quoted: true,
    minOutputRaw: String(rp.minOutputAmount),
    gasCostUsd: body.fee_breakdown ? Number(body.fee_breakdown.gas_cost_usd) : null,
    legCount: body.route_metadata ? body.route_metadata.leg_count : null,
    expiresAt: body.expires_at ?? null,
  };
}

export function isNoLiquidity(body) {
  if (!body) return false;
  const d = body.detail ?? body;
  if (typeof d === 'string') return d.includes('no_liquidity');
  return d && d.error === 'no_liquidity';
}
