const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');
const webpush = require('web-push');
const User = require('../models/User');
const PushSubscription = require('../models/PushSubscription');
const { pushService } = require('../services/pushService');

process.env.JWT_SECRET = 'test-only-jwt-secret-that-is-long-enough';

const subscriptionPayload = {
    endpoint: 'https://push.example.test/account-browser',
    keys: {
        p256dh: 'A'.repeat(88),
        auth: 'B'.repeat(24)
    }
};

test('authenticated push routes bind, inspect, test, and remove only the current user subscription', async t => {
    const userId = new mongoose.Types.ObjectId();
    const user = { _id: userId, name: 'Recipient', email: 'recipient@example.com', role: ['Editor'], isActive: true };
    const storedRecord = {
        _id: new mongoose.Types.ObjectId(),
        userId,
        endpoint: subscriptionPayload.endpoint,
        keys: subscriptionPayload.keys,
        enabled: true,
        lastSeenAt: new Date(),
        createdAt: new Date(),
        updatedAt: new Date(),
        provider: 'web-push',
        deviceLabel: 'Test browser'
    };
    const calls = { upsert: [], remove: [] };

    const originals = {
        userFindOne: User.findOne,
        findOneAndUpdate: PushSubscription.findOneAndUpdate,
        deleteOne: PushSubscription.deleteOne,
        find: PushSubscription.find,
        findOne: PushSubscription.findOne,
        sendToSubscription: pushService.sendToSubscription
    };
    User.findOne = () => ({ select: async () => user });
    PushSubscription.findOneAndUpdate = async (query, update) => {
        calls.upsert.push({ query, update });
        return storedRecord;
    };
    PushSubscription.deleteOne = async query => {
        calls.remove.push(query);
        return { deletedCount: 1 };
    };
    PushSubscription.find = () => ({
        select: () => ({
            sort: () => ({
                lean: async () => [{
                    _id: storedRecord._id,
                    lastSeenAt: storedRecord.lastSeenAt,
                    createdAt: storedRecord.createdAt,
                    updatedAt: storedRecord.updatedAt,
                    provider: storedRecord.provider,
                    deviceLabel: storedRecord.deviceLabel
                }]
            })
        })
    });
    PushSubscription.findOne = async query => (
        String(query.userId) === String(userId) && query.endpoint === storedRecord.endpoint ? storedRecord : null
    );
    pushService.sendToSubscription = async () => ({ delivered: 1, expired: 0, failed: 0 });

    t.after(() => {
        User.findOne = originals.userFindOne;
        PushSubscription.findOneAndUpdate = originals.findOneAndUpdate;
        PushSubscription.deleteOne = originals.deleteOne;
        PushSubscription.find = originals.find;
        PushSubscription.findOne = originals.findOne;
        pushService.sendToSubscription = originals.sendToSubscription;
    });

    delete require.cache[require.resolve('../routes/push')];
    const pushRouter = require('../routes/push');
    const app = express();
    app.use(express.json());
    app.use('/api/push', pushRouter);
    const server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    t.after(() => server.close());
    const baseUrl = `http://127.0.0.1:${server.address().port}/api/push`;
    const token = jwt.sign({ sub: userId.toString() }, process.env.JWT_SECRET, { expiresIn: '5m' });
    const auth = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

    const anonymous = await fetch(`${baseUrl}/status`);
    assert.equal(anonymous.status, 401);

    const subscribe = await fetch(`${baseUrl}/subscribe`, {
        method: 'POST',
        headers: auth,
        body: JSON.stringify({ userId: 'attacker-selected-id', subscription: subscriptionPayload })
    });
    assert.equal(subscribe.status, 200);
    assert.equal(calls.upsert.length, 1);
    assert.equal(String(calls.upsert[0].update.$set.userId), userId.toString());

    const status = await fetch(`${baseUrl}/status`, { headers: { Authorization: `Bearer ${token}` } });
    assert.deepEqual(await status.json(), {
        enabled: true,
        subscriptionCount: 1,
        subscriptions: [{
            _id: storedRecord._id.toString(),
            lastSeenAt: storedRecord.lastSeenAt.toISOString(),
            createdAt: storedRecord.createdAt.toISOString(),
            updatedAt: storedRecord.updatedAt.toISOString(),
            provider: 'web-push',
            deviceLabel: storedRecord.deviceLabel
        }]
    });

    const otherBrowserTest = await fetch(`${baseUrl}/test`, {
        method: 'POST', headers: auth, body: JSON.stringify({ endpoint: 'https://push.example.test/not-owned' })
    });
    assert.equal(otherBrowserTest.status, 404);

    const testResponse = await fetch(`${baseUrl}/test`, {
        method: 'POST', headers: auth, body: JSON.stringify({ endpoint: subscriptionPayload.endpoint })
    });
    assert.equal(testResponse.status, 200);
    assert.equal((await testResponse.json()).delivered, true);

    const rateLimitedTest = await fetch(`${baseUrl}/test`, {
        method: 'POST', headers: auth, body: JSON.stringify({ endpoint: subscriptionPayload.endpoint })
    });
    assert.equal(rateLimitedTest.status, 429);

    const unsubscribe = await fetch(`${baseUrl}/unsubscribe`, {
        method: 'DELETE', headers: auth, body: JSON.stringify({ endpoint: subscriptionPayload.endpoint })
    });
    assert.equal(unsubscribe.status, 200);
    assert.equal(String(calls.remove[0].userId), userId.toString());
});

test('VAPID public-key endpoint returns a controlled JSON 503 when Web Push is unavailable', async t => {
    const variableNames = ['VAPID_PUBLIC_KEY', 'VAPID_PRIVATE_KEY', 'VAPID_SUBJECT'];
    const previousValues = new Map(variableNames.map(name => [name, process.env[name]]));
    variableNames.forEach(name => { delete process.env[name]; });
    t.after(() => {
        previousValues.forEach((value, name) => {
            if (value === undefined) delete process.env[name];
            else process.env[name] = value;
        });
    });

    delete require.cache[require.resolve('../routes/push')];
    const pushRouter = require('../routes/push');
    const app = express();
    app.use('/api/push', pushRouter);
    const server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    t.after(() => server.close());

    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/push/vapid-public-key`);
    assert.equal(response.status, 503);
    assert.match(response.headers.get('content-type'), /^application\/json/);
    assert.deepEqual(await response.json(), {
        error: 'Browser Web Push is unavailable',
        code: 'WEB_PUSH_UNAVAILABLE'
    });

    const pair = webpush.generateVAPIDKeys();
    process.env.VAPID_PUBLIC_KEY = pair.publicKey;
    process.env.VAPID_PRIVATE_KEY = pair.privateKey;
    process.env.VAPID_SUBJECT = 'mailto:test@example.com';
    const configuredResponse = await fetch(`http://127.0.0.1:${server.address().port}/api/push/vapid-public-key`);
    assert.equal(configuredResponse.status, 200);
    assert.deepEqual(await configuredResponse.json(), { publicKey: pair.publicKey });
});
