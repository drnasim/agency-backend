const express = require('express');

const router = express.Router();

const PRICE_URL = 'https://api.coingecko.com/api/v3/simple/price?ids=bitcoin,ethereum,solana,binancecoin&vs_currencies=usd';
const CACHE_TTL_MS = 60 * 1000;

let cachedPrices = null;
let cachedAt = 0;

const normalizePrices = (data) => ({
  bitcoin: { usd: Number(data?.bitcoin?.usd) || 0 },
  ethereum: { usd: Number(data?.ethereum?.usd) || 0 },
  solana: { usd: Number(data?.solana?.usd) || 0 },
  binancecoin: { usd: Number(data?.binancecoin?.usd) || 0 }
});

router.get('/prices', async (req, res) => {
  if (cachedPrices && Date.now() - cachedAt < CACHE_TTL_MS) {
    return res.json(cachedPrices);
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);

  try {
    const response = await fetch(PRICE_URL, {
      headers: { Accept: 'application/json' },
      signal: controller.signal
    });

    if (!response.ok) {
      if (cachedPrices) return res.json(cachedPrices);
      return res.status(response.status).json({ error: 'Failed to fetch crypto prices' });
    }

    const data = await response.json();
    cachedPrices = normalizePrices(data);
    cachedAt = Date.now();

    res.set('Cache-Control', 'public, max-age=60');
    return res.json(cachedPrices);
  } catch (err) {
    if (cachedPrices) return res.json(cachedPrices);
    return res.status(err.name === 'AbortError' ? 504 : 502).json({ error: 'Failed to fetch crypto prices' });
  } finally {
    clearTimeout(timeout);
  }
});

module.exports = router;
