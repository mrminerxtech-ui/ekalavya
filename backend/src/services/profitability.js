// ============================================================
// PROFITABILITY CALCULATOR SERVICE
// Uses live BTC/KAS/LTC prices from CoinGecko
// ============================================================

const NETWORK_DIFFICULTIES = {
  BTC:  { difficulty: 72_006_146_478_567, block_reward: 3.125, block_time: 600  },
  LTC:  { difficulty: 25_471_010,         block_reward: 12.5,  block_time: 150  },
  DOGE: { difficulty: 10_500_000,         block_reward: 10000, block_time: 60   },
  KAS:  { difficulty: 2_200_000_000,      block_reward: 292,   block_time: 1    },
};

/**
 * Calculate daily revenue for a miner
 * @param {number} hashrate   - TH/s (or GH/s for KAS/LTC)
 * @param {string} algorithm  - 'SHA-256' | 'Scrypt' | 'KHeavyHash' | 'Kadena'
 * @param {number} price_usd  - current coin price in USD
 * @param {number} power_w    - miner power in watts
 * @param {number} elec_cost  - electricity cost $/kWh
 */
function calcProfitability(hashrate, algorithm, price_usd, power_w, elec_cost = 0.06) {
  let daily_coins = 0;

  if (algorithm === 'SHA-256') {
    // BTC mining formula
    const { difficulty, block_reward, block_time } = NETWORK_DIFFICULTIES.BTC;
    const network_hashrate = difficulty * (2 ** 32) / block_time;  // H/s
    const miner_hashrate   = hashrate * 1e12;                      // TH/s → H/s
    const blocks_per_day   = 86400 / block_time;
    daily_coins = (miner_hashrate / network_hashrate) * blocks_per_day * block_reward;
  } else if (algorithm === 'Scrypt') {
    // LTC mining
    const { difficulty, block_reward, block_time } = NETWORK_DIFFICULTIES.LTC;
    const network_hashrate = difficulty * (2 ** 32) / block_time;
    const miner_hashrate   = hashrate * 1e12;
    daily_coins = (miner_hashrate / network_hashrate) * (86400 / block_time) * block_reward;
  } else if (algorithm === 'KHeavyHash') {
    // KAS mining — hashrate in GH/s for KA3
    const miner_ghs        = hashrate;  // already in GH/s
    const network_hashrate = NETWORK_DIFFICULTIES.KAS.difficulty * 2;  // approx
    daily_coins = (miner_ghs * 1e9 / network_hashrate) * 86400 * NETWORK_DIFFICULTIES.KAS.block_reward;
  } else {
    // Fallback estimate
    daily_coins = hashrate * 0.00000005;
  }

  const daily_revenue = daily_coins * price_usd;
  const daily_electricity = (power_w / 1000) * 24 * elec_cost;
  const daily_profit = daily_revenue - daily_electricity;
  const monthly_profit = daily_profit * 30;

  return {
    daily_coins:       parseFloat(daily_coins.toFixed(8)),
    daily_revenue:     parseFloat(daily_revenue.toFixed(2)),
    daily_electricity: parseFloat(daily_electricity.toFixed(2)),
    daily_profit:      parseFloat(daily_profit.toFixed(2)),
    monthly_profit:    parseFloat(monthly_profit.toFixed(2)),
    efficiency:        power_w > 0 && hashrate > 0 ? parseFloat((power_w / hashrate).toFixed(2)) : 0,
  };
}

/**
 * Calculate fleet-wide profitability
 */
function calcFleetProfitability(workers, prices, electricityCost = 0.06) {
  const btcPrice = prices.find(p => p.symbol === 'BTC')?.price_usd || 0;

  return workers
    .filter(w => w.status === 'online')
    .map(w => {
      const result = calcProfitability(
        w.hashrate || 0,
        w.algorithm || 'SHA-256',
        btcPrice,
        w.power || 3200,
        electricityCost
      );
      return { ...w, profitability: result };
    });
}

module.exports = { calcProfitability, calcFleetProfitability };
