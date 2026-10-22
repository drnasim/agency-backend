const Project = require('../models/Project');
const Wallet = require('../models/Wallet');
const { ACTIVE_PROJECT_STATUSES } = require('./projectAssignments');
const { getCryptoPrices } = require('../routes/crypto');

// Business calendar: Bangladesh (UTC+06:00, no daylight saving).
const MONTH_TIME_ZONE = 'Asia/Dhaka';
const DHAKA_OFFSET_MS = 6 * 60 * 60 * 1000;
const currentMonthRange = (now = new Date()) => {
    const local = new Date(now.getTime() + DHAKA_OFFSET_MS);
    const year = local.getUTCFullYear(), month = local.getUTCMonth();
    return {
        month: `${year}-${String(month + 1).padStart(2, '0')}`,
        start: new Date(Date.UTC(year, month, 1) - DHAKA_OFFSET_MS),
        end: new Date(Date.UTC(year, month + 1, 1) - DHAKA_OFFSET_MS)
    };
};

// Match invoice billing: seconds above 30 round up; legacy billableMinutes and
// fixed budget remain fallbacks. Payment status never affects project value.
const projectValueUsd = project => {
    if (project.budgetType === 'Per Minute Rate') {
        const seconds = Math.max(0, Math.floor(Number(project.durationMinutes) || 0)) * 60
            + Math.max(0, Math.floor(Number(project.durationSeconds) || 0));
        const minutes = Math.floor(seconds / 60) + (seconds % 60 > 30 ? 1 : 0)
            || Number(project.billableMinutes) || 0;
        const rate = Number(project.perMinuteRate ?? project.rate) || 0;
        if (rate > 0 && minutes > 0) return Number((rate * minutes).toFixed(2));
    }
    return Number(project.budget) || 0;
};

const fetchJson = async (url, body) => {
    const response = await fetch(url, {
        signal: AbortSignal.timeout(5000),
        headers: { Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) },
        ...(body ? { method: 'POST', body: JSON.stringify(body) } : {})
    });
    if (!response.ok) throw new Error('Balance provider unavailable');
    const data = await response.json();
    if (data.error) throw new Error('Balance provider rejected the request');
    return data;
};
const fetchWalletBalance = async wallet => {
    let balance;
    if (wallet.network === 'BTC') {
        const data = await fetchJson(`https://mempool.space/api/address/${encodeURIComponent(wallet.address)}`);
        const funded = data.chain_stats?.funded_txo_sum, spent = data.chain_stats?.spent_txo_sum;
        if (!Number.isFinite(funded) || !Number.isFinite(spent)) throw new Error('Invalid Bitcoin balance');
        balance = (funded - spent) / 1e8;
    } else {
        const endpoints = { ETH: 'https://cloudflare-eth.com', SOL: 'https://solana-rpc.publicnode.com', BNB: 'https://bsc-dataseed.binance.org/' };
        const url = endpoints[wallet.network];
        if (!url) throw new Error('Unsupported wallet network');
        const solana = wallet.network === 'SOL';
        const data = await fetchJson(url, {
            jsonrpc: '2.0', id: 1,
            method: solana ? 'getBalance' : 'eth_getBalance',
            params: solana ? [wallet.address] : [wallet.address, 'latest']
        });
        if (solana ? !Number.isFinite(data.result?.value) : !/^0x[0-9a-f]+$/i.test(data.result)) {
            throw new Error('Invalid wallet balance response');
        }
        balance = solana ? data.result.value / 1e9 : Number.parseInt(data.result, 16) / 1e18;
    }
    if (!Number.isFinite(balance) || balance < 0) throw new Error('Invalid wallet balance');
    return balance;
};

const cryptoBalance = async (wallets, { loadPrices = getCryptoPrices, loadBalance = fetchWalletBalance } = {}) => {
    if (!wallets.length) return { totalUsd: 0, status: 'ready' };
    try {
        const [quote, balances] = await Promise.all([
            loadPrices(), Promise.all(wallets.map(loadBalance))
        ]);
        const coins = { BTC: 'bitcoin', ETH: 'ethereum', SOL: 'solana', BNB: 'binancecoin' };
        let total = 0;
        wallets.forEach((wallet, index) => {
            const price = Number(quote.prices?.[coins[wallet.network]]?.usd);
            if (!(price > 0) || !Number.isFinite(price)) throw new Error('Price unavailable');
            total += balances[index] * price;
        });
        return { totalUsd: Number(total.toFixed(2)), status: quote._meta?.isStale ? 'stale' : 'ready' };
    } catch {
        // Never present an incomplete wallet total as zero or a complete balance.
        return { totalUsd: null, status: 'unavailable' };
    }
};

const getAdminOverview = async (now = new Date()) => {
    const range = currentMonthRange(now);
    const [activeProjects, projects, wallets] = await Promise.all([
        Project.countDocuments({ status: { $in: [...ACTIVE_PROJECT_STATUSES] } }),
        Project.find({ createdAt: { $gte: range.start, $lt: range.end } })
            .select('budget budgetType perMinuteRate durationMinutes durationSeconds billableMinutes').lean(),
        Wallet.find().select('address network').lean()
    ]);
    const crypto = await cryptoBalance(wallets);
    return {
        activeProjects,
        monthlyProjectValueUsd: Number(projects.reduce((sum, project) => sum + projectValueUsd(project), 0).toFixed(2)),
        month: range.month,
        timeZone: MONTH_TIME_ZONE,
        cryptoBalance: crypto,
        updatedAt: now.toISOString()
    };
};

module.exports = { getAdminOverview, currentMonthRange, projectValueUsd, cryptoBalance, fetchWalletBalance };
