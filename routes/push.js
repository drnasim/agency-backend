const express = require('express');
const crypto = require('crypto');
const PushSubscription = require('../models/PushSubscription');
const { authenticate } = require('../middleware/authenticate');
const { readPushConfig } = require('../config/push');
const { pushService } = require('../services/pushService');

const router = express.Router();
const testRateLimits = new Map();
const TEST_WINDOW_MS = 30 * 1000;

const cleanDiagnosticText = (value, maxLength) => String(value || '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLength);

const isValidKey = (value, minLength, maxLength) => {
    const key = String(value || '');
    return key.length >= minLength && key.length <= maxLength && /^[A-Za-z0-9_-]+$/.test(key);
};

const validateSubscription = (value) => {
    if (!value || typeof value !== 'object') return 'A push subscription is required';
    const endpoint = String(value.endpoint || '').trim();
    let parsedEndpoint;
    try {
        parsedEndpoint = new URL(endpoint);
    } catch {
        return 'The push subscription endpoint is invalid';
    }
    if (parsedEndpoint.protocol !== 'https:' || endpoint.length > 2048) {
        return 'The push subscription endpoint must use HTTPS';
    }
    if (!isValidKey(value.keys?.p256dh, 40, 512) || !isValidKey(value.keys?.auth, 8, 256)) {
        return 'The push subscription keys are invalid';
    }
    return null;
};

const endpointFingerprint = (endpoint) => crypto
    .createHash('sha256')
    .update(String(endpoint || ''))
    .digest('hex')
    .slice(0, 16);

router.get('/vapid-public-key', (req, res) => {
    res.set('Cache-Control', 'no-store');
    try {
        return res.json({ publicKey: readPushConfig().publicKey });
    } catch {
        return res.status(503).json({
            error: 'Browser Web Push is unavailable',
            code: 'WEB_PUSH_UNAVAILABLE'
        });
    }
});

router.use(authenticate);

router.post('/subscribe', async (req, res) => {
    try {
        const subscription = req.body?.subscription;
        const validationError = validateSubscription(subscription);
        if (validationError) return res.status(400).json({ error: validationError });

        const endpoint = String(subscription.endpoint).trim();
        const now = new Date();
        const record = await PushSubscription.findOneAndUpdate(
            { endpoint },
            {
                $set: {
                    userId: req.user._id,
                    keys: {
                        p256dh: String(subscription.keys.p256dh),
                        auth: String(subscription.keys.auth)
                    },
                    enabled: true,
                    lastSeenAt: now,
                    userAgent: cleanDiagnosticText(req.get('user-agent'), 500),
                    deviceLabel: cleanDiagnosticText(req.body?.deviceLabel, 120),
                    provider: 'web-push'
                },
                $setOnInsert: { createdAt: now }
            },
            { new: true, upsert: true, runValidators: true, setDefaultsOnInsert: true }
        );

        return res.status(200).json({
            enabled: true,
            stored: true,
            endpointFingerprint: endpointFingerprint(record.endpoint),
            lastSeenAt: record.lastSeenAt
        });
    } catch (error) {
        console.error('Browser push subscription could not be stored:', error.message);
        return res.status(500).json({ error: 'The browser subscription could not be stored' });
    }
});

router.delete('/unsubscribe', async (req, res) => {
    try {
        const endpoint = String(req.body?.endpoint || '').trim();
        if (!endpoint || endpoint.length > 2048) {
            return res.status(400).json({ error: 'A valid subscription endpoint is required' });
        }
        const result = await PushSubscription.deleteOne({ endpoint, userId: req.user._id });
        return res.json({ disabled: true, removed: result.deletedCount > 0 });
    } catch (error) {
        console.error('Browser push subscription could not be removed:', error.message);
        return res.status(500).json({ error: 'The browser subscription could not be removed' });
    }
});

router.get('/status', async (req, res) => {
    try {
        const subscriptions = await PushSubscription.find({ userId: req.user._id, enabled: true })
            .select('lastSeenAt createdAt updatedAt deviceLabel provider')
            .sort({ lastSeenAt: -1 })
            .lean();
        return res.json({ enabled: subscriptions.length > 0, subscriptionCount: subscriptions.length, subscriptions });
    } catch (error) {
        console.error('Browser push status lookup failed:', error.message);
        return res.status(500).json({ error: 'Notification status is unavailable' });
    }
});

router.post('/test', async (req, res) => {
    try {
        const userId = req.user._id.toString();
        const now = Date.now();
        for (const [limitedUserId, expiresAt] of testRateLimits) {
            if (expiresAt <= now) testRateLimits.delete(limitedUserId);
        }
        const retryAt = testRateLimits.get(userId) || 0;
        if (retryAt > now) {
            res.set('Retry-After', String(Math.ceil((retryAt - now) / 1000)));
            return res.status(429).json({ error: 'Please wait before sending another test notification' });
        }

        const endpoint = String(req.body?.endpoint || '').trim();
        if (!endpoint) return res.status(400).json({ error: 'The current browser subscription is required' });

        const record = await PushSubscription.findOne({ endpoint, userId: req.user._id, enabled: true });
        if (!record) return res.status(404).json({ error: 'This browser is not subscribed for the current account' });

        testRateLimits.set(userId, now + TEST_WINDOW_MS);
        const eventId = `test:${userId}:${now}`;
        const result = await pushService.sendToSubscription(record, {
            type: 'test',
            title: 'Browser notifications are working',
            body: 'This test was delivered securely by the Fortivus server.',
            url: '/settings',
            entityId: record._id.toString(),
            tag: eventId
        }, { eventId });

        if (!result.delivered) {
            const status = result.expired ? 410 : 502;
            return res.status(status).json({ error: result.expired
                ? 'This browser subscription expired and was removed. Enable notifications again.'
                : 'The push provider did not accept the test notification' });
        }

        return res.json({ delivered: true });
    } catch (error) {
        console.error('Browser test push failed:', error.message);
        return res.status(500).json({ error: 'The test notification could not be delivered' });
    }
});

module.exports = router;
module.exports.validateSubscription = validateSubscription;
