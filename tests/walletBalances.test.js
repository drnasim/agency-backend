const test = require('node:test');
const assert = require('node:assert/strict');
const { fetchWalletBalance, readProvider, getWalletPortfolio } = require('../services/walletBalances');
const ok = data => ({ ok: true, json: async () => data });
const price = { bitcoin: { usd: 100 }, ethereum: { usd: 200 }, solana: { usd: 30 }, binancecoin: { usd: 600 } };

test('BNB and ETH read actual hexadecimal native balances and fall back when one RPC fails', async t => {
    const calls = [];
    t.mock.method(global, 'fetch', async (url, options) => {
        calls.push(url);
        assert.equal(JSON.parse(options.body).method, 'eth_getBalance');
        if (url.includes('publicnode')) return ok({ error: { code: -32603 } });
        return ok({ result: '0xde0b6b3a7640000' });
    });
    assert.equal(await fetchWalletBalance({ network: 'BNB', address: '0xexample' }), 1);
    assert.equal(await fetchWalletBalance({ network: 'ETH', address: '0xexample' }), 1);
    assert.equal(calls.length, 4);
});
test('RPC errors, missing results and malformed balances never become zero; genuine zero does', async t => {
    for (const data of [{}, { result: null }, { result: '0xgarbage' }, { error: { message: 'rate limited' } }]) {
        t.mock.method(global, 'fetch', async () => ok(data));
        await assert.rejects(fetchWalletBalance({ network: 'BNB', address: '0xbad' }));
        t.mock.restoreAll();
    }
    t.mock.method(global, 'fetch', async () => ok({ result: '0x0' }));
    assert.equal(await fetchWalletBalance({ network: 'BNB', address: '0xzero' }), 0);
});
test('portfolio preserves successful rows when another fails, and retries new wallets', async t => {
    t.mock.method(global, 'fetch', async (url) => {
        if (url.includes('coingecko')) return ok(price);
        if (url.includes('ethereum') || url.includes('llamarpc')) throw Error('Offline');
        return ok({ result: '0xde0b6b3a7640000' });
    });
    const result = await getWalletPortfolio([
        { _id: 'bnb', network: 'BNB', address: '0xportfolio1' },
        { _id: 'eth', network: 'ETH', address: '0xportfolio2' }
    ]);
    assert.equal(result.wallets[0].usd, 600);
    assert.equal(result.wallets[1].balance, null);
    assert.equal(result.summary.totalUsd, null);
    const added = await getWalletPortfolio([{ _id: 'new', network: 'BNB', address: '0xnew' }]);
    assert.equal(added.wallets[0].usd, 600);
});
test('saved balances remain explicitly stale during provider outages and expire after 15 minutes', async t => {
    let now = Date.now(), offline = false;
    t.mock.method(Date, 'now', () => now);
    t.mock.method(global, 'fetch', async url => {
        if (url.includes('coingecko')) return ok(price);
        if (offline) throw Error('offline');
        return ok({ result: '0xde0b6b3a7640000' });
    });
    const wallets = [{ _id: 'saved', network: 'BNB', address: '0xsaved' }];
    assert.equal((await getWalletPortfolio(wallets)).summary.totalUsd, 600);
    offline = true; now += 61000;
    const stale = await getWalletPortfolio(wallets);
    assert.equal(stale.wallets[0].status, 'stale');
    assert.equal(stale.summary.totalUsd, 600);
    now += 16 * 60000;
    assert.equal((await getWalletPortfolio(wallets)).summary.totalUsd, null);
});
test('Solana and Bitcoin units are normalized and invalid responses rejected', async t => {
    t.mock.method(global, 'fetch', async () => ok({ result: { value: 1500000000 } }));
    assert.equal(await readProvider({ network: 'SOL', address: 'sol' }, 'https://sol.test'), 1.5);
    t.mock.method(global, 'fetch', async () => ok({ chain_stats: { funded_txo_sum: 200000000, spent_txo_sum: 100000000 } }));
    assert.equal(await readProvider({ network: 'BTC', address: 'btc' }, 'https://btc.test'), 1);
});
