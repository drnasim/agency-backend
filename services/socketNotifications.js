const { normalizeNotificationPayload } = require('./notificationPayload');

const NOTIFICATION_SOCKET_EVENT = 'notification_event';
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

module.exports = {
    NOTIFICATION_SOCKET_EVENT,
    emitNotificationToUserIds,
    getNotificationSocketRoom,
    isNotificationSocketRoom,
    isPublicChatSocketRoom
};
