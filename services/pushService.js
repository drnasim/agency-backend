const webpush = require('web-push');
const PushSubscription = require('../models/PushSubscription');

const EVENT_TTL_MS = 10 * 60 * 1000;
const recentEvents = new Map();

const cleanText = (value, maxLength) => String(value || '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLength);

const safeInternalUrl = (value, fallback = '/dashboard') => {
    const raw = String(value || '').trim();
    if (!raw.startsWith('/') || raw.startsWith('//') || raw.includes('\\')) return fallback;
    try {
        const parsed = new URL(raw, 'https://push.invalid');
        if (parsed.origin !== 'https://push.invalid') return fallback;
        return `${parsed.pathname}${parsed.search}${parsed.hash}`;
    } catch {
        return fallback;
    }
};

const normalizePayload = (payload = {}) => {
    const allowedTypes = new Set(['message', 'project', 'call', 'test']);
    const type = allowedTypes.has(payload.type) ? payload.type : 'test';
    const entityId = cleanText(payload.entityId, 100);
    const eventId = cleanText(payload.eventId, 160);
    const fallbackTag = eventId || `${type}:${entityId || Date.now()}`;

    return {
        type,
        title: cleanText(payload.title || 'Fortivus Group', 100),
        body: cleanText(payload.body || 'You have a new notification.', 180),
        url: safeInternalUrl(payload.url),
        entityId,
        eventId,
        tag: cleanText(payload.tag || fallbackTag, 160),
        icon: safeInternalUrl(payload.icon || '/favicon-192.png', '/favicon-192.png'),
        badge: safeInternalUrl(payload.badge || '/favicon-32.png', '/favicon-32.png')
    };
};

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
        const normalizedPayload = normalizePayload({ ...payload, eventId: eventId || payload.eventId });
        const dedupeId = cleanText(eventId || normalizedPayload.eventId, 160);
        const dedupeKey = dedupeId ? `${userId}:${dedupeId}` : '';
        if (dedupeKey && eventWasRecentlySent(dedupeKey)) {
            return { delivered: 0, expired: 0, failed: 0, duplicate: true };
        }

        try {
            const records = await SubscriptionModel.find({ userId, enabled: true });
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
        const uniqueUserIds = [...new Set((userIds || []).map(String).filter(Boolean))];
        return Promise.all(uniqueUserIds.map(userId => sendToUser(userId, payload, options)));
    };

    const sendToSubscription = async (record, payload, options = {}) => {
        const normalizedPayload = normalizePayload({ ...payload, eventId: options.eventId || payload.eventId });
        return sendRecord(record, normalizedPayload);
    };

    return { sendToUser, sendToUsers, sendToSubscription, normalizePayload };
};

const pushService = createPushService();

module.exports = { createPushService, normalizePayload, pushService, safeInternalUrl };
