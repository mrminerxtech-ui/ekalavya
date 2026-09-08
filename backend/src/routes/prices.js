const express=require('express'); const router=express.Router();
const axios=require('axios'); const store=require('../services/store');
const COINGECKO='https://api.coingecko.com/api/v3';
const CACHE_TTL=60_000;
const COINS={ bitcoin:{symbol:'BTC',icon:'₿'}, ethereum:{symbol:'ETH',icon:'Ξ'}, litecoin:{symbol:'LTC',icon:'Ł'}, dogecoin:{symbol:'DOGE',icon:'Ð'}, kaspa:{symbol:'KAS',icon:'K'} };
async function fetchPrices() {
  const { data }=await axios.get(`${COINGECKO}/simple/price`, { params:{ ids:Object.keys(COINS).join(','), vs_currencies:'usd', include_24hr_change:true }, timeout:8000 });
  return Object.entries(COINS).map(([id,meta])=>({ id, symbol:meta.symbol, icon:meta.icon, price_usd:data[id]?.usd||0, change_24h:+(data[id]?.usd_24h_change||0).toFixed(2), updated_at:new Date().toISOString() }));
}
router.get('/', async (req,res)=>{
  try {
    const { data, age }=store.getPricesCache();
    if(data&&age<CACHE_TTL) return res.json(data);
    const prices=await fetchPrices(); store.setPricesCache(prices); res.json(prices);
  } catch(e) {
    const { data }=store.getPricesCache(); if(data) return res.json(data);
    res.status(503).json({ error:`Price feed unavailable: ${e.message}` });
  }
});
module.exports=router;
