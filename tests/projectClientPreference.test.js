const test = require('node:test');
const assert = require('node:assert/strict');
// Isolate the preference handlers from database connections.
const User = { findById() {}, updateOne() {} };
const Client = { exists() {} };
require.cache[require.resolve('../models/User')] = { exports: User };
require.cache[require.resolve('../models/Client')] = { exports: Client };
const { read, write } = require('../services/projectClientPreference');

const response = () => ({
    statusCode: 200,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; }
});

test('last selected project client belongs only to the authenticated user', async t => {
    const saved = new Map();
    const clientA = 'aaaaaaaaaaaaaaaaaaaaaaaa';
    const clientB = 'bbbbbbbbbbbbbbbbbbbbbbbb';
    t.mock.method(Client, 'exists', async () => true);
    t.mock.method(User, 'updateOne', async (filter, update) => {
        saved.set(String(filter._id), update.$set.lastProjectClient);
    });
    t.mock.method(User, 'findById', id => ({
        select: async () => ({ lastProjectClient: saved.get(String(id)) })
    }));
    const empty = response();
    await read({ user: { _id: 'user-a' } }, empty);
    assert.deepEqual(empty.body, { clientId: '' });
    for (const [userId, clientId] of [['user-a', clientA], ['user-b', clientB]]) {
        const res = response();
        await write({ user: { _id: userId }, body: { clientId, userId: 'someone-else' } }, res);
        assert.equal(res.statusCode, 200);
    }
    for (const [userId, clientId] of [['user-a', clientA], ['user-b', clientB]]) {
        const res = response();
        await read({ user: { _id: userId } }, res);
        assert.deepEqual(res.body, { clientId });
    }
    assert.equal(saved.has('someone-else'), false);
    await write({ user: { _id: 'user-a' }, body: { clientId: clientB } }, response());
    assert.equal(saved.get('user-a'), clientB);
});

test('invalid or deleted clients cannot replace a remembered client', async t => {
    const update = t.mock.method(User, 'updateOne', async () => {});
    t.mock.method(Client, 'exists', async () => false);
    for (const [clientId, status] of [[null, 400], ['not-an-id', 400], ['aaaaaaaaaaaaaaaaaaaaaaaa', 404]]) {
        const res = response();
        await write({ user: { _id: 'user-a' }, body: { clientId } }, res);
        assert.equal(res.statusCode, status);
    }
    assert.equal(update.mock.callCount(), 0);
});
