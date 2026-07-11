const test = require('node:test');
const assert = require('node:assert/strict');
const { createNotificationDelivery } = require('../services/notificationDelivery');

test('realtime delivery runs first and succeeds when recipients have no PushSubscription', async () => {
    const io = { name: 'authenticated socket server' };
    const calls = [];
    let resolutionCount = 0;
    const delivery = createNotificationDelivery({
        resolveRecipientIds: async (references, excluded) => {
            resolutionCount += 1;
            assert.deepEqual(references, ['recipient-reference']);
            assert.deepEqual(excluded, ['sender-reference']);
            return ['immutable-user-id'];
        },
        emitRealtime: (selectedIo, recipientIds, payload) => {
            calls.push('realtime');
            assert.equal(selectedIo, io);
            assert.deepEqual(recipientIds, ['immutable-user-id']);
            assert.equal(payload.eventId, 'message:message-id');
            return 1;
        },
        // Zero deliveries models an authenticated recipient without any stored subscription.
        sendBrowserPush: async recipientIds => {
            calls.push('push');
            assert.deepEqual(recipientIds, ['immutable-user-id']);
            return [{ delivered: 0, expired: 0, failed: 0, duplicate: false }];
        },
        getIo: () => io,
        logger: { error: assert.fail }
    });

    const result = await delivery.deliverNotificationToReferences(
        ['recipient-reference'],
        { type: 'message', title: 'New message', eventId: 'message:message-id' },
        { eventId: 'message:message-id', excludeReferences: ['sender-reference'] }
    );

    assert.equal(resolutionCount, 1);
    assert.deepEqual(calls, ['realtime', 'push']);
    assert.equal(result.realtimeEmitted, 1);
    assert.equal(result.pushResults[0].delivered, 0);
});

test('a browser-push failure is contained after realtime delivery', async () => {
    const calls = [];
    const errors = [];
    const delivery = createNotificationDelivery({
        resolveRecipientIds: async () => ['immutable-user-id'],
        emitRealtime: () => {
            calls.push('realtime');
            return 1;
        },
        sendBrowserPush: async () => {
            calls.push('push');
            throw new Error('simulated push outage');
        },
        getIo: () => ({}),
        logger: { error: (...args) => errors.push(args) }
    });

    const result = await delivery.deliverNotificationToReferences([], {
        type: 'project',
        title: 'Assigned',
        eventId: 'new_project:project-id'
    });

    assert.deepEqual(calls, ['realtime', 'push']);
    assert.equal(result.realtimeEmitted, 1);
    assert.deepEqual(result.pushResults, []);
    assert.equal(errors.length, 1);
    assert.match(errors[0].join(' '), /simulated push outage/);
});
