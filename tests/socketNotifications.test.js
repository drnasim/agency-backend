const test = require('node:test');
const assert = require('node:assert/strict');
const jwt = require('jsonwebtoken');
const User = require('../models/User');
const {
    MOBILE_SESSION_READY_SOCKET_EVENT,
    NOTIFICATION_SOCKET_EVENT,
    PROJECT_ASSIGNMENT_SOCKET_EVENT,
    emitNotificationToUserIds,
    emitProjectAssignmentEventToUserIds,
    getNotificationSocketRoom,
    initializeAuthenticatedNotificationSocket,
    isNotificationSocketRoom,
    isPublicChatSocketRoom
} = require('../services/socketNotifications');
const { attachAuthenticatedSocketUser } = require('../middleware/authenticate');

test('legacy sockets may omit authentication but supplied invalid sessions are rejected', async () => {
    const legacyError = await new Promise(resolve => {
        void attachAuthenticatedSocketUser({ handshake: { auth: {} } }, resolve);
    });
    assert.equal(legacyError, undefined);

    const previousSecret = process.env.JWT_SECRET;
    process.env.JWT_SECRET = 'socket-auth-contract-test-secret';
    try {
        const authError = await new Promise(resolve => {
            void attachAuthenticatedSocketUser({
                handshake: { auth: { token: 'invalid-session-token' } }
            }, resolve);
        });
        assert.ok(authError instanceof Error);
        assert.equal(authError.message, 'Socket authentication failed');
    } finally {
        if (previousSecret === undefined) delete process.env.JWT_SECRET;
        else process.env.JWT_SECRET = previousSecret;
    }
});

test('mobile session readiness is emitted only after an authenticated socket joins its private room', async () => {
    const operations = [];
    const socket = {
        authenticatedUser: { _id: 'editor-user-id' },
        async join(room) {
            operations.push({ kind: 'join', room });
        },
        emit(event, payload) {
            operations.push({ kind: 'emit', event, payload });
        }
    };

    const payload = await initializeAuthenticatedNotificationSocket(socket);
    assert.deepEqual(payload, { ready: true, userId: 'editor-user-id' });
    assert.deepEqual(operations, [
        { kind: 'join', room: getNotificationSocketRoom('editor-user-id') },
        {
            kind: 'emit',
            event: MOBILE_SESSION_READY_SOCKET_EVENT,
            payload: { ready: true, userId: 'editor-user-id' }
        }
    ]);

    const unauthenticatedOperations = [];
    const unauthenticated = await initializeAuthenticatedNotificationSocket({
        join: room => unauthenticatedOperations.push({ kind: 'join', room }),
        emit: (event, value) => unauthenticatedOperations.push({ kind: 'emit', event, value })
    });
    assert.equal(unauthenticated, null);
    assert.deepEqual(unauthenticatedOperations, []);
});

test('a valid supplied token is authenticated before mobile readiness joins the private room', async () => {
    const previousSecret = process.env.JWT_SECRET;
    const realFindOne = User.findOne;
    const user = { _id: 'authenticated-editor-id', name: 'Editor', role: ['Editor'] };
    const operations = [];
    let capturedUserFilter;
    process.env.JWT_SECRET = 'valid-socket-session-test-secret';
    User.findOne = filter => {
        capturedUserFilter = filter;
        return {
            select: () => Promise.resolve(user)
        };
    };

    try {
        const socket = {
            handshake: {
                auth: {
                    token: jwt.sign({ sub: user._id }, process.env.JWT_SECRET, { expiresIn: '1m' })
                }
            },
            async join(room) {
                operations.push({ kind: 'join', room });
            },
            emit(event, payload) {
                operations.push({ kind: 'emit', event, payload });
            }
        };
        const authError = await new Promise(resolve => {
            void attachAuthenticatedSocketUser(socket, resolve);
        });
        assert.equal(authError, undefined);
        assert.equal(socket.authenticatedUser, user);
        assert.equal(capturedUserFilter._id, user._id);

        await initializeAuthenticatedNotificationSocket(socket);
        assert.deepEqual(operations, [
            { kind: 'join', room: getNotificationSocketRoom(user._id) },
            {
                kind: 'emit',
                event: MOBILE_SESSION_READY_SOCKET_EVENT,
                payload: { ready: true, userId: user._id }
            }
        ]);
    } finally {
        User.findOne = realFindOne;
        if (previousSecret === undefined) delete process.env.JWT_SECRET;
        else process.env.JWT_SECRET = previousSecret;
    }
});

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

test('assignment realtime events preserve the mobile action and deep-link contract', () => {
    const emissions = [];
    const io = {
        to: room => ({ emit: (event, payload) => emissions.push({ room, event, payload }) })
    };
    const count = emitProjectAssignmentEventToUserIds(io, ['editor-a'], {
        action: 'assigned',
        eventId: 'project_assignment:req-1:assigned:2',
        title: 'New Project Assigned',
        body: 'Launch video for Acme has been assigned to you.',
        projectId: 'project-1',
        projectName: 'Launch video',
        clientName: 'Acme',
        projectUrl: '/project/project-1',
        assignmentRequestId: 'req-1',
        assignmentVersion: 2,
        assignmentStatus: 'pending',
        assignmentExpiresAt: '2026-08-28T10:02:00.000Z',
        ringTimeoutSeconds: 120
    });

    assert.equal(count, 1);
    assert.equal(emissions[0].event, PROJECT_ASSIGNMENT_SOCKET_EVENT);
    assert.equal(emissions[0].payload.type, 'project_assignment');
    assert.equal(emissions[0].payload.projectUrl, '/project/project-1');
    assert.equal(emissions[0].payload.title, 'New Project Assigned');
    assert.equal(emissions[0].payload.body, 'Launch video for Acme has been assigned to you.');
    assert.equal(emissions[0].payload.ringTimeoutSeconds, 120);
});
