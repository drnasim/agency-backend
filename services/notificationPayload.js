const cleanText = (value, maxLength) => String(value || '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLength);

const safeInternalUrl = (value, fallback = '/dashboard') => {
    const raw = String(value || '').trim();
    if (!raw.startsWith('/') || raw.startsWith('//') || raw.includes('\\')) return fallback;
    try {
        const parsed = new URL(raw, 'https://notification.invalid');
        if (parsed.origin !== 'https://notification.invalid') return fallback;
        return `${parsed.pathname}${parsed.search}${parsed.hash}`;
    } catch {
        return fallback;
    }
};

const normalizeNotificationPayload = (payload = {}) => {
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
        badge: safeInternalUrl(payload.badge || '/favicon-32.png', '/favicon-32.png'),
        recipientUserId: cleanText(payload.recipientUserId, 100),
        senderUserId: cleanText(payload.senderUserId, 100)
    };
};

module.exports = { cleanText, normalizeNotificationPayload, safeInternalUrl };
