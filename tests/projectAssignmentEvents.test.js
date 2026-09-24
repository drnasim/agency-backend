const test = require('node:test');
const assert = require('node:assert/strict');

const { createProjectAssignmentPublisher } = require('../services/projectAssignmentEvents');

test('assignment FCM starts first and still completes when supplemental Socket.IO fails', async () => {
    const calls = [];
    const errors = [];
    const publisher = createProjectAssignmentPublisher({
        sendMobileEvents: async (userIds, event) => {
            calls.push({ kind: 'fcm', userIds, event });
            return [{ token: 'device-token', delivered: true, messageId: 'message-1' }];
        },
        getAdminIds: async () => {
            calls.push({ kind: 'admin-lookup' });
            return ['admin-1'];
        },
        emitRealtime: (_io, userIds, event) => {
            calls.push({ kind: 'socket', userIds, event });
            throw new Error('socket server unavailable');
        },
        logger: { error: (...args) => errors.push(args) }
    });

    const result = await publisher({
        project: {
            _id: 'project-1',
            title: 'Launch video',
            assignedEditorUserId: 'editor-1',
            assignmentStatus: 'pending',
            assignmentRequestId: 'request-1',
            assignmentVersion: 1
        },
        action: 'assigned',
        recipientUserIds: ['editor-1'],
        io: { name: 'broken socket layer' }
    });

    assert.equal(calls[0].kind, 'fcm');
    assert.deepEqual(calls[0].userIds, ['editor-1']);
    assert.equal(calls[0].event.action, 'assigned');
    assert.equal(calls[0].event.assignmentRequestId, 'request-1');
    assert.deepEqual(calls[2].userIds, ['editor-1', 'admin-1']);
    assert.equal(result.realtimeEmitted, 0);
    assert.deepEqual(result.mobileResults, [{
        token: 'device-token',
        delivered: true,
        messageId: 'message-1'
    }]);
    assert.match(errors[0].join(' '), /realtime delivery failed.*socket server unavailable/);
});
