const webpush = require('web-push');
const PushSubscription = require('../models/PushSubscription');
const {
    cleanText,
    normalizeNotificationPayload,
    safeInternalUrl
} = require('./notificationPayload');

const EVENT_TTL_MS = 10 * 60 * 1000;
const recentEvents = new Map();

const normalizePayload = normalizeNotificationPayload;

const eventWasRecentlySent = (key, now = Date.now()) => {
    for (const [cachedKey, expiresAt] of recentEvents) {
        if (expiresAt <= now) recentEvents.delete(cachedKey);
    }
    if (recentEvents.has(key)) return true;
    recentEvents.set(key, now + EVENT_TTL_MS);
    return false;
};

const createPushService = ({
    webpushClient = webpush,
    SubscriptionModel = PushSubscription,
    logger = console
} = {}) => {
    const removeExpired = async (record) => {
        try {
            await SubscriptionModel.deleteOne({ _id: record._id });
        } catch (error) {
            logger.error('Could not remove an expired browser push subscription:', error.message);
        }
    };

    const sendRecord = async (record, normalizedPayload) => {
        const subscription = typeof record.toWebPushSubscription === 'function'
            ? record.toWebPushSubscription()
            : { endpoint: record.endpoint, keys: record.keys };

        try {
            await webpushClient.sendNotification(subscription, JSON.stringify(normalizedPayload), { TTL: 60 });
            return { delivered: 1, expired: 0, failed: 0 };
        } catch (error) {
            if (error.statusCode === 404 || error.statusCode === 410) {
                await removeExpired(record);
                return { delivered: 0, expired: 1, failed: 0 };
            }
            logger.error('Browser push delivery failed:', {
                statusCode: error.statusCode || null,
                message: cleanText(error.message, 200)
            });
            return { delivered: 0, expired: 0, failed: 1 };
        }
    };

    const sendToUser = async (userId, payload, { eventId } = {}) => {
        const immutableUserId = cleanText(userId, 100);
        const normalizedPayload = normalizePayload({
            ...payload,
            eventId: eventId || payload.eventId,
            // Each browser-push payload is bound to the backend-selected user.
            recipientUserId: immutableUserId
        });
        const dedupeId = cleanText(eventId || normalizedPayload.eventId, 160);
        const dedupeKey = dedupeId ? `${immutableUserId}:${dedupeId}` : '';
        if (dedupeKey && eventWasRecentlySent(dedupeKey)) {
            return { delivered: 0, expired: 0, failed: 0, duplicate: true };
        }

        try {
            const records = await SubscriptionModel.find({ userId: immutableUserId, enabled: true });
            const results = await Promise.all(records.map(record => sendRecord(record, normalizedPayload)));
            return results.reduce((total, result) => ({
                delivered: total.delivered + result.delivered,
                expired: total.expired + result.expired,
                failed: total.failed + result.failed,
                duplicate: false
            }), { delivered: 0, expired: 0, failed: 0, duplicate: false });
        } catch (error) {
            logger.error('Browser push lookup failed:', cleanText(error.message, 200));
            return { delivered: 0, expired: 0, failed: 1, duplicate: false };
        }
    };

    const sendToUsers = async (userIds, payload, options = {}) => {
        const uniqueUserIds = [...new Set((userIds || [])
            .map(userId => String(userId || '').trim())
            .filter(Boolean))];
        return Promise.all(uniqueUserIds.map(userId => sendToUser(userId, payload, options)));
    };

    const sendToSubscription = async (record, payload, options = {}) => {
        const normalizedPayload = normalizePayload({
            ...payload,
            eventId: options.eventId || payload.eventId,
            recipientUserId: cleanText(record?.userId, 100)
        });
        return sendRecord(record, normalizedPayload);
    };

    return { sendToUser, sendToUsers, sendToSubscription, normalizePayload };
};

const pushService = createPushService();

module.exports = { createPushService, normalizePayload, pushService, safeInternalUrl };
