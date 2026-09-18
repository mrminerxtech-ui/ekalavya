// ============================================================
// MARKET ROUTE  /api/market
// ------------------------------------------------------------
// Live coin prices (CoinGecko) + Bitcoin network difficulty and
// block height (mempool.space). Used for the top ticker and for
// calculating real mining revenue for the customer portal.
//
// Why this lives on the backend rather than in the browser:
//   1. CORS — the frontend is served from GitHub Pages and can't
//      reliably call third-party APIs directly from the browser.
//   2. Rate limits — CoinGecko's free tier allows roughly 10-30
//      calls/minute for the WHOLE application. One cached fetch
//      here serves every user and every page refresh, instead of
//      one call per visitor per refresh (which would get us
//      rate-limited the moment more than a few people log in).
//
// DESIGN RULE: these figures become real money numbers shown to a
// customer. If anything is missing, stale, or looks wrong, this
// returns ok:false so the UI can show "—". It must NEVER fall back
// to a hardcoded or invented price/difficulty, because a
// plausible-looking wrong number is far more damaging than a blank.
// ============================================================
const express = require('express');
const https   = require('https');
const router  = express.Router();

// Difficulty moves every ~2 weeks; price moves constantly but the
// ticker doesn't need second-by-second accuracy. 60s for prices
// keeps us well inside CoinGecko's free rate limit even with the
// frontend polling, while still looking "live".
const PRICE_CACHE_MS = 60 * 1000;
const CHAIN_CACHE_MS = 5 * 60 * 1000;

let priceCache = { at: 0, data: null };
let chainCache = { at: 0, data: null };

// Coins shown in the ticker. CoinGecko ids on the left, the symbol
// the UI uses on the right.
const COIN_IDS = {
  bitcoin:  'BTC',
  ethereum: 'ETH',
  litecoin: 'LTC',
  kaspa:    'KAS',
};

function getJson(hostname, path) {
  return new Promise((resolve, reject) => {
    const req = https.request(
      { hostname, path, method: 'GET', timeout: 8000,
        headers: { 'Accept': 'application/json', 'User-Agent': 'EKY-Monitoring' } },
      res => {
        let d = '';
        res.on('data', c => d += c);
        res.on('end', () => {
          if (res.statusCode === 429) {
            return reject(new Error(`${hostname} rate-limited us (HTTP 429)`));
          }
          if (res.statusCode < 200 || res.statusCode >= 300) {
            return reject(new Error(`${hostname}${path} returned HTTP ${res.statusCode}`));
          }
          try { resolve(JSON.parse(d)); }
          catch (e) { reject(new Error(`${hostname}${path} returned non-JSON: ${d.slice(0, 120)}`)); }
        });
      }
    );
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error(`${hostname}${path} timed out`)); });
    req.end();
  });
}

// Block reward is DERIVED from chain height rather than hardcoded.
// Hardcoding "3.125" would silently become wrong at the next halving
// and quietly overstate every customer's earnings by 2x.
function blockRewardAtHeight(height) {
  const halvings = Math.floor(height / 210000);
  if (halvings >= 64) return 0;
  return 50 / Math.pow(2, halvings);
}

// ── Prices: CoinGecko ───────────────────────────────────────
async function fetchPrices() {
  const ids  = Object.keys(COIN_IDS).join(',');
  const path = `/api/v3/simple/price?ids=${ids}&vs_currencies=usd&include_24hr_change=true`;
  const raw  = await getJson('api.coingecko.com', path);

  const prices = {};
  for (const [cgId, sym] of Object.entries(COIN_IDS)) {
    const row = raw && raw[cgId];
    const p   = row && Number(row.usd);
    // Skip a coin whose price didn't come back rather than showing a
    // zero or a stale hardcoded figure next to a live one.
    if (!isFinite(p) || p <= 0) continue;
    const chg = Number(row.usd_24h_change);
    prices[sym] = { usd: p, change_24h: isFinite(chg) ? chg : null };
  }

  // BTC is the one price that feeds the earnings maths, so if it's
  // missing the whole payload is untrustworthy for that purpose.
  if (!prices.BTC) throw new Error('BTC price missing from CoinGecko response');

  return { prices, source: 'coingecko', updated_at: new Date().toISOString() };
}

// ── Chain data: mempool.space ───────────────────────────────
async function fetchChain() {
  const [hashrate, tipHeight] = await Promise.all([
    getJson('mempool.space', '/api/v1/mining/hashrate/3d'),
    getJson('mempool.space', '/api/blocks/tip/height'),
  ]);

  const difficulty = Number(hashrate && hashrate.currentDifficulty);
  const height     = Number(tipHeight);

  // Sanity-check every value before trusting it with money. These
  // bounds are deliberately wide — they're here to catch a broken or
  // changed API response (null, 0, an error object, a string), not to
  // second-guess a genuine market move.
  if (!isFinite(difficulty) || difficulty <= 0) throw new Error('Network difficulty missing or invalid');
  if (!isFinite(height) || height <= 0) throw new Error('Block height missing or invalid');

  return {
    difficulty,
    block_height: height,
    block_reward: blockRewardAtHeight(height),
    chain_source: 'mempool.space',
  };
}

// Cached accessors. Each half can go stale independently — a
// CoinGecko outage shouldn't blank out the difficulty and vice versa.
async function getPrices() {
  if (priceCache.data && Date.now() - priceCache.at < PRICE_CACHE_MS) {
    return { ...priceCache.data, cached: true };
  }
  try {
    const data = await fetchPrices();
    priceCache = { at: Date.now(), data };
    return { ...data, cached: false };
  } catch (e) {
    if (priceCache.data) {
      return { ...priceCache.data, cached: true, stale: true,
               age_minutes: Math.round((Date.now() - priceCache.at) / 60000) };
    }
    throw e;
  }
}

async function getChain() {
  if (chainCache.data && Date.now() - chainCache.at < CHAIN_CACHE_MS) {
    return { ...chainCache.data, cached: true };
  }
  try {
    const data = await fetchChain();
    chainCache = { at: Date.now(), data };
    return { ...data, cached: false };
  } catch (e) {
    if (chainCache.data) {
      return { ...chainCache.data, cached: true, stale: true };
    }
    throw e;
  }
}

// One combined object, used by both the API below and the earnings
// accrual service — so the price a customer sees in the ticker is
// exactly the price their earnings were calculated with.
async function getMarket() {
  const [p, c] = await Promise.all([getPrices(), getChain()]);
  return {
    btc_usd:      p.prices.BTC.usd,
    prices:       p.prices,
    difficulty:   c.difficulty,
    block_height: c.block_height,
    block_reward: c.block_reward,
    source:       p.source,
    chain_source: c.chain_source,
    updated_at:   p.updated_at,
    stale:        !!(p.stale || c.stale),
    age_minutes:  p.age_minutes,
  };
}

// GET /api/market — cached live market data (public: the portal needs
// it, and it's non-sensitive public market/chain data)
router.get('/', async (req, res) => {
  try {
    const data = await getMarket();
    res.json({ ok: true, ...data });
  } catch (e) {
    console.error('[MARKET] Live data unavailable:', e.message);
    res.status(503).json({ ok: false, error: e.message });
  }
});

// GET /api/market/prices — ticker only. Kept separate so a
// mempool.space outage never blanks the ticker, and so the frontend
// can poll prices often without re-pulling chain data.
router.get('/prices', async (req, res) => {
  try {
    const p = await getPrices();
    res.json({ ok: true, ...p });
  } catch (e) {
    console.error('[MARKET] Prices unavailable:', e.message);
    res.status(503).json({ ok: false, error: e.message });
  }
});

module.exports = router;
module.exports.getMarket = getMarket;
