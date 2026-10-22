const Wallet = require('../models/Wallet');
const { getCryptoPrices } = require('../routes/crypto');
const cache = new Map(), pending = new Map();
const FRESH_MS = 60000, STALE_MS = 15 * 60000;
const RPCS = {
    BNB: ['https://bsc-rpc.publicnode.com', 'https://bsc-dataseed.bnbchain.org'],
    ETH: ['https://ethereum-rpc.publicnode.com', 'https://eth.llamarpc.com'],
    SOL: ['https://solana-rpc.publicnode.com', 'https://api.mainnet-beta.solana.com']
};
const json = async (url, body) => {
    const response = await fetch(url, { signal: AbortSignal.timeout(4000),
        headers: { Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) },
        ...(body ? { method: 'POST', body: JSON.stringify(body) } : {}) });
    if (!response.ok) throw Error('Provider unavailable');
    const data = await response.json();
    if (data.error) throw Error('RPC rejected balance request');
    return data;
};
const readProvider = async (wallet, url) => {
    let balance;
    if (wallet.network === 'BTC') {
        const data = await json(`${url}/api/address/${encodeURIComponent(wallet.address.trim())}`);
        const { funded_txo_sum: funded, spent_txo_sum: spent } = data.chain_stats || {};
        if (!Number.isFinite(funded) || !Number.isFinite(spent)) throw Error('Invalid Bitcoin balance');
        balance = (funded - spent) / 1e8;
    } else {
        const sol = wallet.network === 'SOL';
        const data = await json(url, { jsonrpc: '2.0', id: 1, method: sol ? 'getBalance' : 'eth_getBalance',
            params: sol ? [wallet.address.trim()] : [wallet.address.trim(), 'latest'] });
        if (sol) {
            if (!Number.isFinite(data.result?.value)) throw Error('Invalid Solana balance');
            balance = data.result.value / 1e9;
        } else {
            if (typeof data.result !== 'string' || !/^0x[0-9a-f]+$/i.test(data.result)) throw Error('Invalid EVM balance');
            balance = Number(BigInt(data.result)) / 1e18;
        }
    }
    if (!Number.isFinite(balance) || balance < 0) throw Error('Invalid balance');
    return balance;
};
const fetchWalletBalance = async wallet => {
    const urls = wallet.network === 'BTC' ? ['https://mempool.space', 'https://blockstream.info'] : RPCS[wallet.network];
    if (!urls) throw Error('Unsupported network');
    return Promise.any(urls.map(url => readProvider(wallet, url)));
};
const walletSnapshot = async wallet => {
    const key = `${wallet.network}:${wallet.address.trim()}`;
    const saved = cache.get(key);
    if (saved && Date.now() - saved.at < FRESH_MS) return { ...saved, status: 'ready' };
    if (pending.has(key)) return pending.get(key);
    const task = (async () => {
        try {
            const value = { balance: await fetchWalletBalance(wallet), at: Date.now() };
            if (cache.size >= 1000) cache.delete(cache.keys().next().value);
            cache.set(key, value);
            return { ...value, status: 'ready' };
        } catch {
            if (saved && Date.now() - saved.at < STALE_MS) return { ...saved, status: 'stale' };
            return { balance: null, at: null, status: 'unavailable' };
        } finally { pending.delete(key); }
    })();
    pending.set(key, task);
    return task;
};
const getWalletPortfolio = async (providedWallets) => {
    const wallets = providedWallets || await Wallet.find().select('name address network').lean();
    if (!wallets.length) return { wallets: [], summary: { totalUsd: 0, status: 'ready' } };
    const [quote, snapshots] = await Promise.all([
        getCryptoPrices().catch(() => null), Promise.all(wallets.map(walletSnapshot))
    ]);
    const coins = { BTC: 'bitcoin', ETH: 'ethereum', SOL: 'solana', BNB: 'binancecoin' };
    const rows = wallets.map((wallet, i) => {
        const snapshot = snapshots[i], price = quote?.prices?.[coins[wallet.network]]?.usd;
        const usd = Number.isFinite(snapshot.balance) && Number.isFinite(price) && price > 0 ? snapshot.balance * price : null;
        return { id: String(wallet._id), network: wallet.network, balance: snapshot.balance,
            usd, priceUsd: price > 0 ? price : null,
            status: usd === null ? 'unavailable' : snapshot.status === 'stale' || quote?._meta?.isStale ? 'stale' : 'ready',
            updatedAt: snapshot.at ? new Date(snapshot.at).toISOString() : null };
    });
    const complete = rows.every(row => row.usd !== null);
    return { wallets: rows, summary: {
        totalUsd: complete ? Number(rows.reduce((sum, row) => sum + row.usd, 0).toFixed(2)) : null,
        status: !complete ? 'unavailable' : rows.some(row => row.status === 'stale') ? 'stale' : 'ready'
    } };
};
module.exports = { getWalletPortfolio, fetchWalletBalance, readProvider };
