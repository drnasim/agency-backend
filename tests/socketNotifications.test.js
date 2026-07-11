const test = require('node:test');
const assert = require('node:assert/strict');
const {
    NOTIFICATION_SOCKET_EVENT,
    emitNotificationToUserIds,
    getNotificationSocketRoom,
    isNotificationSocketRoom,
    isPublicChatSocketRoom
} = require('../services/socketNotifications');

test('socket notification normalization does not load browser-push services or subscription storage', () => {
    const pushServicePath = require.resolve('../services/pushService');
    const pushSubscriptionPath = require.resolve('../models/PushSubscription');
    assert.equal(require.cache[pushServicePath], undefined);
    assert.equal(require.cache[pushSubscriptionPath], undefined);
});

test('realtime notification rooms are derived from unique backend user IDs', () => {
    const emissions = [];
    const io = {
        to: room => ({ emit: (event, payload) => emissions.push({ room, event, payload }) })
    };
    const count = emitNotificationToUserIds(io, ['user-a', 'user-a', 'user-b'], {
        type: 'project',
        title: 'Assigned',
        body: 'Project assigned',
        url: '/project/abc',
        entityId: 'abc',
        eventId: 'new_project:abc',
        recipientUserId: 'frontend-spoofed-user',
        senderUserId: 'authenticated-sender-id'
    });

    assert.equal(count, 2);
    assert.deepEqual(emissions.map(item => item.room), [
        getNotificationSocketRoom('user-a'),
        getNotificationSocketRoom('user-b')
    ]);
    assert.ok(emissions.every(item => item.event === NOTIFICATION_SOCKET_EVENT));
    assert.ok(emissions.every(item => item.payload.eventId === 'new_project:abc'));
    assert.deepEqual(emissions.map(item => item.payload.recipientUserId), ['user-a', 'user-b']);
    assert.ok(emissions.every(item => item.payload.senderUserId === 'authenticated-sender-id'));
});

test('private notification rooms cannot be joined through the public chat-room event', () => {
    assert.equal(isNotificationSocketRoom('notification:user:abc'), true);
    assert.equal(isNotificationSocketRoom(' notification:user:abc'), true);
    assert.equal(isNotificationSocketRoom('regular-chat-room'), false);
    assert.equal(isNotificationSocketRoom(['regular-chat-room', 'notification:user:abc']), true);
    assert.equal(isPublicChatSocketRoom('regular-chat-room'), true);
    assert.equal(isPublicChatSocketRoom(['regular-chat-room', 'notification:user:abc']), false);
    assert.equal(isPublicChatSocketRoom(' notification:user:abc'), false);
    assert.equal(isPublicChatSocketRoom({ room: 'regular-chat-room' }), false);
});
