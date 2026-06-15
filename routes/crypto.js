const express = require('express');

const router = express.Router();

const COINGECKO_PRICE_URL = 'https://api.coingecko.com/api/v3/simple/price?ids=bitcoin,ethereum,solana,binancecoin&vs_currencies=usd';
const COINPAPRIKA_TICKERS = {
  bitcoin: 'btc-bitcoin',
  ethereum: 'eth-ethereum',
  solana: 'sol-solana',
  binancecoin: 'bnb-binance-coin'
};
const CACHE_TTL_MS = 60 * 1000;
const PRICE_TIMEOUT_MS = 5000;

let cachedPrices = null;
let cachedAt = 0;

const normalizeCoinGeckoPrices = (data) => ({
  bitcoin: { usd: Number(data?.bitcoin?.usd) || 0 },
  ethereum: { usd: Number(data?.ethereum?.usd) || 0 },
  solana: { usd: Number(data?.solana?.usd) || 0 },
  binancecoin: { usd: Number(data?.binancecoin?.usd) || 0 }
});

const normalizeCoinPaprikaPrices = (data) => ({
  bitcoin: { usd: Number(data?.bitcoin?.quotes?.USD?.price) || 0 },
  ethereum: { usd: Number(data?.ethereum?.quotes?.USD?.price) || 0 },
  solana: { usd: Number(data?.solana?.quotes?.USD?.price) || 0 },
  binancecoin: { usd: Number(data?.binancecoin?.quotes?.USD?.price) || 0 }
});

const hasAnyPrice = (prices = {}) => Object.values(prices).some(coin => Number(coin?.usd) > 0);

const pricePayload = (prices, meta = {}) => ({
  prices,
  ...prices,
  _meta: {
    isStale: Boolean(meta.stale),
    stale: Boolean(meta.stale),
    source: meta.source || 'live',
    cachedAt: cachedAt ? new Date(cachedAt).toISOString() : null,
    error: meta.error || '',
    providers: meta.providers || []
  }
});

const fetchJsonWithTimeout = async (url, providerName) => {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), PRICE_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      headers: { Accept: 'application/json' },
      signal: controller.signal
    });

    let data = null;
    try {
      data = await response.json();
    } catch {
      data = null;
    }

    if (!response.ok) {
      throw new Error(`${providerName} returned ${response.status}`);
    }

    return data;
  } catch (error) {
    if (error.name === 'AbortError') {
      throw new Error(`${providerName} timed out`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
};

const fetchProviderPrices = async (provider) => {
  if (provider.fetchPrices) {
    const prices = await provider.fetchPrices();
    if (!hasAnyPrice(prices)) {
      throw new Error(`${provider.name} returned no usable prices`);
    }
    return prices;
  }

  const data = await fetchJsonWithTimeout(provider.url, provider.name);
  const prices = provider.normalize(data);
  if (!hasAnyPrice(prices)) {
    throw new Error(`${provider.name} returned no usable prices`);
  }
  return prices;
};

const fetchCoinPaprikaPrices = async () => {
  const entries = await Promise.all(
    Object.entries(COINPAPRIKA_TICKERS).map(async ([coinKey, tickerId]) => {
      const data = await fetchJsonWithTimeout(
        `https://api.coinpaprika.com/v1/tickers/${tickerId}`,
        `coinpaprika ${coinKey}`
      );
      return [coinKey, data];
    })
  );

  return normalizeCoinPaprikaPrices(Object.fromEntries(entries));
};

const priceProviders = [
  {
    name: 'coingecko',
    url: COINGECKO_PRICE_URL,
    normalize: normalizeCoinGeckoPrices
  },
  {
    name: 'coinpaprika',
    fetchPrices: fetchCoinPaprikaPrices
  }
];

router.get('/prices', async (req, res) => {
  if (cachedPrices && Date.now() - cachedAt < CACHE_TTL_MS) {
    return res.json(pricePayload(cachedPrices, { stale: false, source: 'cache' }));
  }

  const providerResults = [];

  for (const provider of priceProviders) {
    try {
      const prices = await fetchProviderPrices(provider);
      cachedPrices = prices;
      cachedAt = Date.now();

      res.set('Cache-Control', 'public, max-age=60');
      return res.json(pricePayload(cachedPrices, {
        stale: false,
        source: provider.name,
        providers: [
          ...providerResults,
          { name: provider.name, ok: true }
        ]
      }));
    } catch (error) {
      providerResults.push({
        name: provider.name,
        ok: false,
        error: error.message
      });
    }
  }

  const errorMessage = providerResults.map(result => result.error).filter(Boolean).join('; ') || 'Price providers unavailable';

  if (cachedPrices) {
    return res.json(pricePayload(cachedPrices, {
      stale: true,
      source: 'stale-cache',
      error: errorMessage,
      providers: providerResults
    }));
  }

  return res.status(503).json({
    error: 'Crypto price providers unavailable',
    reason: 'provider_error',
    isStale: false,
    providers: providerResults
  });
});

module.exports = router;
