const test = require('node:test');
const assert = require('node:assert/strict');
const { createPushService, normalizePayload, safeInternalUrl } = require('../services/pushService');

test('push service sends to every device and removes only expired subscriptions', async () => {
    const removed = [];
    const records = [
        { _id: 'one', endpoint: 'https://push.example/one', keys: { p256dh: 'a', auth: 'b' } },
        { _id: 'two', endpoint: 'https://push.example/two', keys: { p256dh: 'c', auth: 'd' } },
        { _id: 'three', endpoint: 'https://push.example/three', keys: { p256dh: 'e', auth: 'f' } }
    ];
    const SubscriptionModel = {
        find: async () => records,
        deleteOne: async query => { removed.push(query._id); }
    };
    const attempted = [];
    const payloads = [];
    const webpushClient = {
        sendNotification: async (subscription, serializedPayload) => {
            attempted.push(subscription.endpoint);
            payloads.push(JSON.parse(serializedPayload));
            if (subscription.endpoint.endsWith('/two')) throw Object.assign(new Error('gone'), { statusCode: 410 });
            if (subscription.endpoint.endsWith('/three')) throw Object.assign(new Error('temporary'), { statusCode: 503 });
        }
    };
    const logs = [];
    const service = createPushService({
        SubscriptionModel,
        webpushClient,
        logger: { error: (...args) => logs.push(args) }
    });

    const result = await service.sendToUser('user-1', {
        type: 'message',
        title: 'Hello',
        body: 'Preview',
        url: '/dashboard?chat=room',
        recipientUserId: 'frontend-spoofed-user',
        senderUserId: 'authenticated-sender-id'
    }, { eventId: 'message:service-test-1' });

    assert.deepEqual(attempted.sort(), records.map(record => record.endpoint).sort());
    assert.ok(payloads.every(payload => payload.recipientUserId === 'user-1'));
    assert.ok(payloads.every(payload => payload.senderUserId === 'authenticated-sender-id'));
    assert.deepEqual(removed, ['two']);
    assert.deepEqual(result, { delivered: 1, expired: 1, failed: 1, duplicate: false });
    assert.equal(logs.length, 1);
});

test('push service suppresses a repeated event for the same recipient', async () => {
    let calls = 0;
    const service = createPushService({
        SubscriptionModel: { find: async () => [{ _id: 'one', endpoint: 'https://push.example/one', keys: {} }], deleteOne: async () => {} },
        webpushClient: { sendNotification: async () => { calls += 1; } },
        logger: { error: () => {} }
    });
    const payload = { type: 'project', title: 'Assigned', url: '/project/123' };
    const first = await service.sendToUser('user-dedupe', payload, { eventId: 'project:dedupe-test-1' });
    const second = await service.sendToUser('user-dedupe', payload, { eventId: 'project:dedupe-test-1' });
    assert.equal(first.delivered, 1);
    assert.equal(second.duplicate, true);
    assert.equal(calls, 1);
});

test('each Web Push payload is stamped with its backend-selected immutable recipient ID', async () => {
    const payloads = [];
    const service = createPushService({
        SubscriptionModel: {
            find: async ({ userId }) => [{
                _id: `subscription-${userId}`,
                endpoint: `https://push.example/${userId}`,
                keys: {}
            }],
            deleteOne: async () => {}
        },
        webpushClient: {
            sendNotification: async (subscription, serializedPayload) => {
                payloads.push({ endpoint: subscription.endpoint, payload: JSON.parse(serializedPayload) });
            }
        },
        logger: { error: assert.fail }
    });

    await service.sendToUsers(['recipient-a', 'recipient-b'], {
        type: 'project',
        title: 'Assigned',
        recipientUserId: 'frontend-spoofed-user'
    }, { eventId: 'project:per-recipient-payload-test' });

    assert.deepEqual(payloads.map(item => item.payload.recipientUserId).sort(), ['recipient-a', 'recipient-b']);
    assert.ok(payloads.every(item => item.endpoint.endsWith(item.payload.recipientUserId)));
});

test('payload normalization strips control text and rejects external URLs', () => {
    const payload = normalizePayload({
        type: 'message',
        title: 'Hello\u0000 world',
        body: 'A   short preview',
        url: 'https://evil.example/private',
        icon: '//evil.example/icon.png'
    });
    assert.equal(payload.title, 'Hello world');
    assert.equal(payload.body, 'A short preview');
    assert.equal(payload.url, '/dashboard');
    assert.equal(payload.icon, '/favicon-192.png');
    assert.equal(safeInternalUrl('/project/123?from=push'), '/project/123?from=push');
});
