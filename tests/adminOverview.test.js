const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const jwt = require('jsonwebtoken');
const User = require('../models/User');
const Project = require('../models/Project');
const Wallet = require('../models/Wallet');
const service = require('../services/adminOverview');
const router = require('../routes/adminOverview');

test('Bangladesh month boundaries include the local first day and exclude next month, including December', () => {
    const before = service.currentMonthRange(new Date('2026-09-30T17:59:59Z'));
    const after = service.currentMonthRange(new Date('2026-09-30T18:00:00Z'));
    assert.equal(before.month, '2026-09');
    assert.equal(after.month, '2026-10');
    assert.equal(after.start.toISOString(), '2026-09-30T18:00:00.000Z');
    assert.equal(after.end.toISOString(), '2026-10-31T18:00:00.000Z');
    assert.equal(service.currentMonthRange(new Date('2026-12-20Z')).end.toISOString(), '2026-12-31T18:00:00.000Z');
});

test('project billing follows fixed and per-minute invoice rules independently of payment status', () => {
    for (const paymentStatus of ['Paid', 'Unpaid', 'Partial']) {
        assert.equal(service.projectValueUsd({ budget: 100, paymentStatus }), 100);
        assert.equal(service.projectValueUsd({ budgetType: 'Per Minute Rate', perMinuteRate: 10, durationMinutes: 2, durationSeconds: 31, budget: 999, paymentStatus }), 30);
    }
    assert.equal(service.projectValueUsd({ budgetType: 'Per Minute Rate', perMinuteRate: 10, durationMinutes: 2, durationSeconds: 30 }), 20);
    assert.equal(service.projectValueUsd({ budgetType: 'Per Minute Rate', perMinuteRate: 10, billableMinutes: 5 }), 50);
    assert.equal(service.projectValueUsd({ budgetType: 'Per Minute Rate', budget: 15 }), 15);
});

test('overview counts all editors and sums all current-month projects, including paid/unpaid and terminal work', async t => {
    const now = new Date('2026-10-22T12:00:00Z');
    const records = [
        { createdAt: new Date('2026-09-30T18:00:00Z'), budget: 100, status: 'Completed', paymentStatus: 'Paid', assignedEditor: 'A' },
        { createdAt: now, budget: 200, status: 'Pending', paymentStatus: 'Unpaid', assignedEditor: 'B' },
        { createdAt: now, budget: 50, status: 'Cancelled', paymentStatus: 'Unpaid' },
        { createdAt: new Date('2026-10-31T18:00:00Z'), budget: 999 },
        { createdAt: new Date('2026-09-30T17:59:59Z'), budget: 999 }
    ];
    t.mock.method(Project, 'countDocuments', async filter => {
        assert.deepEqual(Object.keys(filter), ['status']);
        assert.deepEqual(filter.status.$in, ['Pending', 'In Progress', 'Submitted', 'Under Review', 'Revision']);
        return 23;
    });
    t.mock.method(Project, 'find', filter => {
        assert.deepEqual(Object.keys(filter), ['createdAt']);
        return { select: () => ({ lean: async () => records.filter(p => p.createdAt >= filter.createdAt.$gte && p.createdAt < filter.createdAt.$lt) }) };
    });
    t.mock.method(Wallet, 'find', () => ({ select: () => ({ lean: async () => [] }) }));
    const overview = await service.getAdminOverview(now);
    assert.equal(overview.activeProjects, 23);
    assert.equal(overview.monthlyProjectValueUsd, 350);
    assert.deepEqual(overview.cryptoBalance, { totalUsd: 0, status: 'ready' });
});

test('crypto totals convert every wallet to USD and never return partial totals on failure', async () => {
    const wallets = [{ network: 'BTC' }, { network: 'ETH' }];
    const loadPrices = async () => ({ prices: { bitcoin: { usd: 60000 }, ethereum: { usd: 3000 } } });
    const loadBalance = async wallet => wallet.network === 'BTC' ? 0.5 : 2;
    assert.deepEqual(await service.cryptoBalance(wallets, { loadPrices, loadBalance }), { totalUsd: 36000, status: 'ready' });
    assert.deepEqual(await service.cryptoBalance(wallets, { loadPrices, loadBalance: async () => { throw Error('offline'); } }), { totalUsd: null, status: 'unavailable' });
    assert.equal((await service.cryptoBalance(wallets, { loadBalance, loadPrices: async () => ({ prices: {} }) })).totalUsd, null);
    assert.equal((await service.cryptoBalance(wallets, { loadBalance, loadPrices: async () => ({ ...await loadPrices(), _meta: { isStale: true } }) })).status, 'stale');
});

test('HTTP requires a valid active database Admin, ignores claimed roles, and checks revocation on each request', async t => {
    const previous = process.env.JWT_SECRET;
    process.env.JWT_SECRET = 'admin-overview-test-secret';
    t.after(() => { if (previous === undefined) delete process.env.JWT_SECRET; else process.env.JWT_SECRET = previous; });
    let user = { _id: 'user', role: ['Editor'] }, calls = 0;
    t.mock.method(User, 'findOne', filter => {
        assert.deepEqual(filter.isActive, { $ne: false });
        return { select: async () => user };
    });
    t.mock.method(service, 'getAdminOverview', async () => { calls++; return { activeProjects: 12 }; });
    const app = express(); app.use('/api/admin/overview', router);
    const server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
    t.after(() => new Promise(resolve => server.close(resolve)));
    const url = `http://127.0.0.1:${server.address().port}/api/admin/overview`;
    const request = token => fetch(url + '?role=Admin', { headers: token ? { Authorization: `Bearer ${token}` } : {} });
    const token = jwt.sign({ sub: 'user', role: ['Admin'] }, process.env.JWT_SECRET);
    assert.equal((await request()).status, 401);
    assert.equal((await request('bad-token')).status, 401);
    assert.equal((await request(jwt.sign({ sub: 'user', exp: 1 }, process.env.JWT_SECRET))).status, 401);
    assert.equal((await request(token)).status, 403);
    user.role = ['Marketer']; assert.equal((await request(token)).status, 403);
    assert.equal(calls, 0);
    user.role = ['Editor', 'Admin'];
    const allowed = await request(token);
    assert.equal(allowed.status, 200); assert.equal(allowed.headers.get('cache-control'), 'no-store');
    assert.deepEqual(await allowed.json(), { activeProjects: 12 });
    user.role = ['Editor']; assert.equal((await request(token)).status, 403);
    user = null; assert.equal((await request(token)).status, 401);
    assert.equal(calls, 1);
});
