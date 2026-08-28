const test = require('node:test');
const assert = require('node:assert/strict');

const MobileDevice = require('../models/MobileDevice');
const User = require('../models/User');
const {
    buildProjectAssignmentFcmMessage,
    deliverProjectAssignmentMessages,
    getAlarmTokensForUsers,
    getFcmTokensForUserIds,
    isRetryableAssignmentFcmError,
    removeInvalidFcmToken,
    truncateUtf8
} = require('../fcm');

const assignmentPayload = {
    action: 'assigned',
    eventId: 'project_assignment:req-1:assigned:2',
    assignmentRequestId: 'req-1',
    assignmentVersion: 2,
    assignmentStatus: 'pending',
    projectId: 'project-1',
    projectName: 'Launch video',
    clientName: 'Acme',
    deadline: '2026-08-28T10:00:00.000Z',
    priority: 'Urgent',
    assignedAt: '2026-08-26T17:40:00.000Z',
    assignmentExpiresAt: '2026-08-26T17:42:00.000Z',
    ringTimeoutSeconds: 120,
    projectUrl: '/project/project-1',
    title: 'New Project Assigned',
    body: 'Launch video has been assigned to you.'
};

test('assignment FCM is high-priority data-only and remains deliverable after ringing ends', () => {
    const message = buildProjectAssignmentFcmMessage('device-token', assignmentPayload);
    assert.equal(message.token, 'device-token');
    assert.equal('notification' in message, false);
    assert.equal(message.android.priority, 'high');
    assert.equal(message.android.ttl, 7 * 24 * 60 * 60 * 1000);
    assert.equal(message.data.type, 'project_assignment');
    assert.equal(message.data.action, 'assigned');
    assert.equal(message.data.assignmentVersion, '2');
    assert.equal(message.data.assignmentExpiresAt, assignmentPayload.assignmentExpiresAt);
    assert.equal(message.data.projectUrl, '/project/project-1');
    assert.ok(Object.values(message.data).every(value => typeof value === 'string'));
});

test('oversized assignment copy is UTF-8 bounded without changing acceptance identifiers', () => {
    const oversized = '🎬'.repeat(5000);
    const message = buildProjectAssignmentFcmMessage('device-token', {
        ...assignmentPayload,
        projectName: oversized,
        clientName: oversized,
        acceptedByName: oversized,
        title: oversized,
        body: oversized
    });

    assert.equal(message.data.action, assignmentPayload.action);
    assert.equal(message.data.eventId, assignmentPayload.eventId);
    assert.equal(message.data.assignmentRequestId, assignmentPayload.assignmentRequestId);
    assert.equal(message.data.assignmentVersion, String(assignmentPayload.assignmentVersion));
    assert.equal(message.data.projectId, assignmentPayload.projectId);
    assert.ok(Buffer.byteLength(message.data.projectName, 'utf8') <= 240);
    assert.ok(Buffer.byteLength(message.data.clientName, 'utf8') <= 160);
    assert.ok(Buffer.byteLength(message.data.acceptedByName, 'utf8') <= 160);
    assert.ok(Buffer.byteLength(message.data.title, 'utf8') <= 100);
    assert.ok(Buffer.byteLength(message.data.body, 'utf8') <= 320);
    assert.ok(Buffer.byteLength(JSON.stringify(message.data), 'utf8') < 4096);
    assert.ok(Object.values(message.data).every(value => typeof value === 'string'));
});

test('UTF-8 truncation never splits a multibyte character', () => {
    assert.equal(truncateUtf8('AB🎬CD', 6), 'AB🎬');
    assert.equal(Buffer.byteLength(truncateUtf8('🎬'.repeat(100), 31), 'utf8'), 28);
});

test('transient assignment FCM failures retry before reporting delivery failure', async () => {
    let attempts = 0;
    const waits = [];
    const results = await deliverProjectAssignmentMessages(
        ['temporarily-unavailable-device'],
        assignmentPayload,
        {
            messagingClient: {
                async send() {
                    attempts += 1;
                    if (attempts < 3) {
                        const error = new Error('provider temporarily unavailable');
                        error.code = 'messaging/server-unavailable';
                        throw error;
                    }
                    return 'message-after-retry';
                }
            },
            wait: async milliseconds => waits.push(milliseconds)
        }
    );

    assert.equal(isRetryableAssignmentFcmError({ code: 'messaging/server-unavailable' }), true);
    assert.equal(isRetryableAssignmentFcmError({ code: 'messaging/invalid-registration-token' }), false);
    assert.equal(attempts, 3);
    assert.deepEqual(waits, [250, 1000]);
    assert.deepEqual(results, [{
        token: 'temporarily-unavailable-device',
        delivered: true,
        messageId: 'message-after-retry'
    }]);
});

test('all registered devices receive assignment events and invalid tokens are removed', async () => {
    const sent = [];
    const removed = [];
    const results = await deliverProjectAssignmentMessages(
        ['valid-device', 'invalid-device'],
        { ...assignmentPayload, action: 'accepted' },
        {
            messagingClient: {
                async send(message) {
                    sent.push(message);
                    if (message.token === 'invalid-device') {
                        const error = new Error('not registered');
                        error.code = 'messaging/registration-token-not-registered';
                        throw error;
                    }
                    return 'message-1';
                }
            },
            removeInvalidToken: async token => removed.push(token)
        }
    );

    assert.deepEqual(sent.map(message => message.token), ['valid-device', 'invalid-device']);
    assert.deepEqual(removed, ['invalid-device']);
    assert.deepEqual(results, [
        { token: 'valid-device', delivered: true, messageId: 'message-1' },
        {
            token: 'invalid-device',
            delivered: false,
            code: 'messaging/registration-token-not-registered'
        }
    ]);
});

test('private assignment token lookup uses authenticated MobileDevice records only', async () => {
    const realDeviceFind = MobileDevice.find;
    const realUserFind = User.find;
    let legacyLookupAttempted = false;
    MobileDevice.find = () => ({
        select() { return this; },
        async lean() {
            return [
                { fcmToken: 'registered-device-a' },
                { fcmToken: 'registered-device-b' },
                { fcmToken: 'registered-device-a' }
            ];
        }
    });
    User.find = () => {
        legacyLookupAttempted = true;
        throw new Error('Legacy token storage must not be queried');
    };

    try {
        const tokens = await getFcmTokensForUserIds(['user-1']);
        assert.deepEqual(tokens, ['registered-device-a', 'registered-device-b']);
        assert.equal(legacyLookupAttempted, false);
    } finally {
        MobileDevice.find = realDeviceFind;
        User.find = realUserFind;
    }
});

test('generic revision alarms fan out to device registry and deduplicate legacy tokens', async () => {
    const requestedUserIds = [];
    const users = [
        { _id: 'user-1', fcmToken: 'legacy-token-a' },
        { _id: 'user-2', fcmToken: 'registered-token-b' }
    ];
    const tokens = await getAlarmTokensForUsers(users, {
        deviceTokenLookup: async userIds => {
            requestedUserIds.push(...userIds.map(String));
            return ['registered-token-a', 'registered-token-b'];
        }
    });

    assert.deepEqual(requestedUserIds, ['user-1', 'user-2']);
    assert.deepEqual(tokens, ['registered-token-a', 'registered-token-b', 'legacy-token-a']);
});

test('invalid generic tokens are retired from device and legacy registries', async () => {
    const realDeviceDeleteOne = MobileDevice.deleteOne;
    const realUserUpdateMany = User.updateMany;
    const calls = [];
    MobileDevice.deleteOne = async filter => calls.push(['device', filter]);
    User.updateMany = async (filter, update) => calls.push(['user', filter, update]);

    try {
        await removeInvalidFcmToken('invalid-token');
        assert.deepEqual(calls, [
            ['device', { fcmToken: 'invalid-token' }],
            ['user', { fcmToken: 'invalid-token' }, { $set: { fcmToken: '' } }]
        ]);
    } finally {
        MobileDevice.deleteOne = realDeviceDeleteOne;
        User.updateMany = realUserUpdateMany;
    }
});
