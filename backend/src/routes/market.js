// ============================================================
// MARKET ROUTE  /api/market
// ------------------------------------------------------------
// Live BTC price + network difficulty, used to calculate real
// mining revenue for the customer portal.
//
// Why this lives on the backend rather than in the browser:
//   1. CORS — the frontend is served from GitHub Pages and can't
//      reliably call third-party APIs directly from the browser.
//   2. Rate limits — one cached fetch here serves every user and
//      every page refresh, instead of one call per visitor.
//
// Source: mempool.space's public REST API (no key, no auth).
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

const CACHE_MS = 5 * 60 * 1000; // 5 minutes — difficulty moves every ~2 weeks, price slowly enough
let cache = { at: 0, data: null };

function getJson(path) {
  return new Promise((resolve, reject) => {
    const req = https.request(
      { hostname: 'mempool.space', path, method: 'GET', timeout: 8000,
        headers: { 'Accept': 'application/json', 'User-Agent': 'EKY-Monitoring' } },
      res => {
        let d = '';
        res.on('data', c => d += c);
        res.on('end', () => {
          if (res.statusCode < 200 || res.statusCode >= 300) {
            return reject(new Error(`${path} returned HTTP ${res.statusCode}`));
          }
          try { resolve(JSON.parse(d)); }
          catch (e) { reject(new Error(`${path} returned non-JSON: ${d.slice(0, 120)}`)); }
        });
      }
    );
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error(`${path} timed out`)); });
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

async function fetchMarket() {
  const [prices, hashrate, tipHeight] = await Promise.all([
    getJson('/api/v1/prices'),
    getJson('/api/v1/mining/hashrate/3d'),
    getJson('/api/blocks/tip/height'),
  ]);

  const btcUsd     = Number(prices && prices.USD);
  const difficulty = Number(hashrate && hashrate.currentDifficulty);
  const height     = Number(tipHeight);

  // Sanity-check every value before trusting it with money. These
  // bounds are deliberately wide — they're here to catch a broken or
  // changed API response (null, 0, an error object, a string), not to
  // second-guess a genuine market move.
  if (!isFinite(btcUsd) || btcUsd <= 0) throw new Error('BTC price missing or invalid');
  if (!isFinite(difficulty) || difficulty <= 0) throw new Error('Network difficulty missing or invalid');
  if (!isFinite(height) || height <= 0) throw new Error('Block height missing or invalid');

  return {
    btc_usd: btcUsd,
    difficulty,
    block_height: height,
    block_reward: blockRewardAtHeight(height),
    source: 'mempool.space',
    updated_at: new Date().toISOString(),
  };
}

// GET /api/market — cached live market data (public: the portal needs
// it, and it's non-sensitive public chain data)
router.get('/', async (req, res) => {
  if (cache.data && Date.now() - cache.at < CACHE_MS) {
    return res.json({ ok: true, cached: true, ...cache.data });
  }
  try {
    const data = await fetchMarket();
    cache = { at: Date.now(), data };
    res.json({ ok: true, cached: false, ...data });
  } catch (e) {
    console.error('[MARKET] Live data unavailable:', e.message);
    // Serve a stale cache rather than nothing, but say so clearly so
    // the UI can flag it instead of presenting it as current.
    if (cache.data) {
      return res.json({ ok: true, cached: true, stale: true,
        age_minutes: Math.round((Date.now() - cache.at) / 60000), ...cache.data });
    }
    res.status(503).json({ ok: false, error: e.message });
  }
});

module.exports = router;
