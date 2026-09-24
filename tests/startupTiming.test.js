const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');
const { randomUUID } = require('node:crypto');
const User = require('../models/User');
const StartupSample = require('../models/StartupSample');
const { createStartupRouter } = require('../routes/startup');
const { STAGE_IDS, normalizeContext, validateSample, timingProfile, createRateLimiter } = require('../services/startupTiming');
const sample = (overrides = {}) => ({
    sessionId: randomUUID(), context: { platform: 'android', network: 'wifi', cached: true, launch: 'cold', appVersion: '2.2.3' },
    outcome: 'online', durationMs: 1000,
    stages: Object.fromEntries(STAGE_IDS.map(id => [id, { startedAtMs: 0, completedAtMs: 1000, durationMs: 1000, outcome: 'complete' }])),
    ...overrides
});

test('allowlists anonymous timing fields, bounds timings, and validates the full online readiness barrier', () => {
    const value = sample({ userId: 'private', email: 'private@example.com', installationId: 'stable' });
    value.context.userId = 'private';
    value.context.deviceModel = 'identifying';
    value.context.appVersion = 'private@example.com';
    value.stages.backend.token = 'private';
    const clean = validateSample(value);
    assert.ok(clean);
    assert.equal(clean.userId, undefined);
    assert.equal(clean.context.userId, undefined);
    assert.equal(clean.context.deviceModel, undefined);
    assert.equal(clean.context.appVersion, 'unknown');
    assert.equal(clean.stages.backend.token, undefined);
    assert.equal(validateSample(sample({ sessionId: 'installation-identifier' })), null);
    assert.equal(validateSample(sample({ durationMs: 900001 })), null);
    assert.equal(validateSample(sample({ durationMs: NaN })), null);
    assert.equal(validateSample(sample({ stages: {} })), null);
    const partial = sample({ outcome: 'aborted', stages: {} });
    assert.ok(validateSample(partial));
    const wrongClock = sample();
    wrongClock.stages.backend.startedAtMs = 2000;
    assert.equal(validateSample(wrongClock), null);
    const blockedAlerts = sample();
    blockedAlerts.stages.alerts.outcome = 'skipped';
    assert.ok(validateSample(blockedAlerts));
    blockedAlerts.stages.projects.outcome = 'skipped';
    assert.equal(validateSample(blockedAlerts), null);
    assert.equal(normalizeContext({ cached: 'true' }).cached, true);
    assert.equal(normalizeContext({ cached: 'false' }).cached, false);
    assert.equal(normalizeContext({ appVersion: ['2.2.3'] }).appVersion, 'unknown');
    assert.equal(normalizeContext(null).platform, 'unknown');
    assert.equal(validateSample(sample()).ageDays, 0);
    assert.equal(validateSample(sample({ ageDays: 90 })).ageDays, 90);
    for (const ageDays of [-1, 91, 0.5, Infinity, NaN, '1', null]) {
        assert.equal(validateSample(sample({ ageDays })), null);
    }
});

test('profiles have rounded timings and age buckets, with no identifiers or precise timestamps', () => {
    const now = Date.now();
    const profile = timingProfile({ ...sample(), _id: 'db-id', createdAt: new Date(now - 2.2 * 86400000), userId: 'private' }, now);
    assert.equal(profile.ageDays, 2);
    assert.equal(profile.sessionId, undefined);
    assert.equal(profile._id, undefined);
    assert.equal(profile.createdAt, undefined);
    assert.equal(profile.userId, undefined);
    assert.equal(profile.durationMs, 1000);
    const indexes = StartupSample.schema.indexes();
    assert.ok(indexes.some(([keys, options]) => keys.createdAt === 1 && options.expireAfterSeconds === 90 * 86400));
    assert.ok(indexes.some(([keys, options]) => keys.sessionId === 1 && options.unique));
});

test('rate limiter is bounded and expires without retaining account identities', () => {
    let now = 0;
    const limit = createRateLimiter({ now: () => now, maxKeys: 1 });
    assert.equal(limit('a', 'samples', 120), true);
    assert.equal(limit('a', 'samples', 1), false);
    assert.equal(limit('b', 'samples', 1), false);
    now = 3600001;
    assert.equal(limit('b', 'samples', 1), true);
});

test('authenticated HTTP ingestion is replay safe, anonymous, bounded, and returns bounded contextual profiles', async t => {
    process.env.JWT_SECRET = 'startup-tests-only-secret';
    const userId = new mongoose.Types.ObjectId();
    const originalFind = User.findOne;
    User.findOne = () => ({ select: async () => ({ _id: userId, isActive: true }) });
    t.after(() => { User.findOne = originalFind; });
    const documents = new Map();
    const queries = [];
    const now = Date.now();
    const Sample = {
        bulkWrite: async operations => {
            for (const operation of operations) {
                const { filter, update } = operation.updateOne;
                if (!documents.has(filter.sessionId)) documents.set(filter.sessionId, { _id: randomUUID(), ...update.$setOnInsert });
            }
        },
        find: query => ({ select: () => ({ sort: () => ({ limit: limit => ({ lean: async () => {
            queries.push({ query, limit }); return Array.from(documents.values());
        } }) }) }) })
    };
    const app = express();
    app.use(express.json());
    app.use('/api/startup', createStartupRouter({ Sample, now: () => now }));
    const server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    t.after(() => server.close());
    const base = `http://127.0.0.1:${server.address().port}/api/startup`;
    const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${jwt.sign({ sub: String(userId) }, process.env.JWT_SECRET)}` };
    assert.equal((await fetch(`${base}/estimates`)).status, 401);
    assert.equal((await fetch(`${base}/samples`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ samples: [sample()] }) })).status, 401);
    const value = sample({ userId: String(userId), token: 'private', ageDays: 4, recordedAt: now - 4.5 * 86400000 });
    const post = () => fetch(`${base}/samples`, { method: 'POST', headers, body: JSON.stringify({ samples: [value] }) });
    assert.equal((await post()).status, 202);
    assert.equal((await post()).status, 202);
    assert.equal(documents.size, 1);
    assert.equal(Array.from(documents.values())[0].userId, undefined);
    assert.equal(Array.from(documents.values())[0].createdAt.getTime(), now - 4 * 86400000);
    assert.equal(Array.from(documents.values())[0].ageDays, undefined);
    assert.equal(Array.from(documents.values())[0].recordedAt, undefined);
    const response = await fetch(`${base}/estimates?platform=android&network=wifi&cached=true`, { headers });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.samples.length, 1);
    assert.equal(body.samples[0].sessionId, undefined);
    assert.equal(body.samples[0].ageDays, 4);
    assert.equal(queries[0].query['context.platform'], 'android');
    assert.equal(queries[0].query['context.cached'], true);
    assert.equal(queries[0].limit, 192);
    assert.equal(queries[1].limit, 64);
    assert.match(response.headers.get('cache-control'), /no-store/);
    const invalid = await fetch(`${base}/samples`, { method: 'POST', headers, body: JSON.stringify({ samples: Array.from({ length: 13 }, () => sample()) }) });
    assert.equal(invalid.status, 400);
    const malformed = await fetch(`${base}/samples`, { method: 'POST', headers, body: JSON.stringify({ samples: [sample({ stages: {} })] }) });
    assert.equal(malformed.status, 400);
    assert.equal(documents.size, 1);
});

test('database outages and rate limits produce controlled responses, never block app readiness', async t => {
    const app = express();
    app.use(express.json());
    const auth = (req, _res, next) => { req.user = { _id: 'test-user' }; next(); };
    app.use('/unavailable', createStartupRouter({ auth, Sample: { bulkWrite: async () => { throw new Error('offline'); }, find: () => { throw new Error('offline'); } } }));
    app.use('/limited', createStartupRouter({ auth, rateLimit: () => false }));
    const server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    t.after(() => server.close());
    const base = `http://127.0.0.1:${server.address().port}`;
    assert.equal((await fetch(`${base}/unavailable/estimates`)).status, 503);
    assert.equal((await fetch(`${base}/unavailable/samples`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ samples: [sample()] }) })).status, 503);
    const limit = await fetch(`${base}/limited/estimates`);
    assert.equal(limit.status, 429);
    assert.equal(limit.headers.get('retry-after'), '3600');
    const limitedPost = await fetch(`${base}/limited/samples`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ samples: [sample()] }) });
    assert.equal(limitedPost.status, 429);
    assert.equal(limitedPost.headers.get('retry-after'), '3600');
});

test('concurrent duplicate UUID writes are acknowledged, while other write errors are retried', async t => {
    const auth = (req, _res, next) => { req.user = { _id: 'test-user' }; next(); };
    const app = express();
    app.use(express.json());
    for (const [path, writeErrors] of [['duplicate', [{ code: 11000 }]], ['mixed', [{ code: 11000 }, { code: 50 }]]]) {
        app.use(`/${path}`, createStartupRouter({ auth, Sample: { bulkWrite: async () => { throw { writeErrors }; } } }));
    }
    const server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    t.after(() => server.close());
    const post = path => fetch(`http://127.0.0.1:${server.address().port}/${path}/samples`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ samples: [sample()] })
    });
    assert.equal((await post('duplicate')).status, 202);
    assert.equal((await post('mixed')).status, 503);
});
