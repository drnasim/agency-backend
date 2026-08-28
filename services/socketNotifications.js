const { normalizeNotificationPayload } = require('./notificationPayload');

const NOTIFICATION_SOCKET_EVENT = 'notification_event';
const PROJECT_ASSIGNMENT_SOCKET_EVENT = 'project_assignment_event';
const MOBILE_SESSION_READY_SOCKET_EVENT = 'mobile_session_ready';
const NOTIFICATION_ROOM_PREFIX = 'notification:user:';

const getNotificationSocketRoom = (userId) => (
    `${NOTIFICATION_ROOM_PREFIX}${String(userId || '').trim()}`
);

const isNotificationSocketRoom = (room) => {
    if (Array.isArray(room)) return room.some(isNotificationSocketRoom);
    return String(room || '').trim().startsWith(NOTIFICATION_ROOM_PREFIX);
};

const isPublicChatSocketRoom = (room) => (
    typeof room === 'string' && Boolean(room.trim()) && !isNotificationSocketRoom(room)
);

// Socket.IO's transport-level `connect` event does not prove that a client was
// authenticated or joined to its private notification room. Emit a separate
// readiness event only after both conditions have been satisfied. Legacy chat
// sockets without a token remain connected, but never receive this event.
const initializeAuthenticatedNotificationSocket = async socket => {
    const userId = String(socket?.authenticatedUser?._id || '').trim();
    if (!userId) return null;

    await socket.join(getNotificationSocketRoom(userId));
    const payload = { ready: true, userId };
    socket.emit(MOBILE_SESSION_READY_SOCKET_EVENT, payload);
    return payload;
};

const emitNotificationToUserIds = (io, userIds, payload) => {
    if (!io) return 0;
    const uniqueUserIds = [...new Set((userIds || [])
        .map(userId => String(userId || '').trim())
        .filter(Boolean))];
    uniqueUserIds.forEach(userId => {
        const normalizedPayload = normalizeNotificationPayload({
            ...payload,
            // Recipient identity is derived from the authenticated backend user lookup.
            // Never accept or relay a caller-supplied recipient identity.
            recipientUserId: userId
        });
        io.to(getNotificationSocketRoom(userId)).emit(NOTIFICATION_SOCKET_EVENT, normalizedPayload);
    });
    return uniqueUserIds.length;
};

const cleanEventText = (value, maxLength = 200) => String(value || '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLength);

const normalizeProjectAssignmentEvent = (payload = {}) => {
    const allowedActions = new Set(['assigned', 'reassigned', 'delivered', 'accepted', 'cancelled']);
    const acceptedBy = payload.acceptedBy || {};
    return {
        type: 'project_assignment',
        action: allowedActions.has(payload.action) ? payload.action : 'cancelled',
        reason: cleanEventText(payload.reason, 80),
        eventId: cleanEventText(payload.eventId, 180),
        title: cleanEventText(payload.title, 100),
        body: cleanEventText(payload.body, 180),
        projectId: cleanEventText(payload.projectId, 100),
        projectName: cleanEventText(payload.projectName, 160),
        clientName: cleanEventText(payload.clientName, 160),
        projectUrl: cleanEventText(payload.projectUrl, 300),
        assignmentRequestId: cleanEventText(payload.assignmentRequestId, 100),
        assignmentVersion: Math.max(0, Number(payload.assignmentVersion) || 0),
        assignmentStatus: ['pending', 'accepted'].includes(payload.assignmentStatus)
            ? payload.assignmentStatus
            : '',
        priority: ['Low', 'Normal', 'High', 'Urgent'].includes(payload.priority)
            ? payload.priority
            : 'Normal',
        deadline: cleanEventText(payload.deadline, 40),
        assignedAt: cleanEventText(payload.assignedAt, 40),
        deliveredAt: cleanEventText(payload.deliveredAt, 40),
        acceptedAt: cleanEventText(payload.acceptedAt, 40),
        assignmentExpiresAt: cleanEventText(payload.assignmentExpiresAt, 40),
        ringTimeoutSeconds: Math.max(0, Number(payload.ringTimeoutSeconds) || 0),
        acceptedBy: {
            userId: cleanEventText(acceptedBy.userId, 100),
            name: cleanEventText(acceptedBy.name, 160)
        }
    };
};

const emitProjectAssignmentEventToUserIds = (io, userIds, payload) => {
    if (!io) return 0;
    const uniqueUserIds = [...new Set((userIds || [])
        .map(userId => String(userId || '').trim())
        .filter(Boolean))];
    const normalizedPayload = normalizeProjectAssignmentEvent(payload);
    uniqueUserIds.forEach(userId => {
        io.to(getNotificationSocketRoom(userId)).emit(
            PROJECT_ASSIGNMENT_SOCKET_EVENT,
            normalizedPayload
        );
    });
    return uniqueUserIds.length;
};

module.exports = {
    MOBILE_SESSION_READY_SOCKET_EVENT,
    NOTIFICATION_SOCKET_EVENT,
    PROJECT_ASSIGNMENT_SOCKET_EVENT,
    emitNotificationToUserIds,
    emitProjectAssignmentEventToUserIds,
    getNotificationSocketRoom,
    initializeAuthenticatedNotificationSocket,
    isNotificationSocketRoom,
    isPublicChatSocketRoom,
    normalizeProjectAssignmentEvent
};
