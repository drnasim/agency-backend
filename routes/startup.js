const express = require('express');
const StartupSample = require('../models/StartupSample');
const { authenticate } = require('../middleware/authenticate');
const { MAX_BATCH, normalizeContext, validateSample, timingProfile, createRateLimiter } = require('../services/startupTiming');

const createStartupRouter = ({ Sample = StartupSample, auth = authenticate, now = Date.now, rateLimit = createRateLimiter({ now }) } = {}) => {
    const router = express.Router();
    router.use(auth);
    router.use((_req, res, next) => { res.set('Cache-Control', 'private, no-store'); next(); });
    router.post('/samples', async (req, res) => {
        const incoming = req.body?.samples;
        if (!Array.isArray(incoming) || incoming.length < 1 || incoming.length > MAX_BATCH) {
            return res.status(400).json({ error: `Provide between 1 and ${MAX_BATCH} startup samples` });
        }
        const samples = incoming.map(validateSample);
        if (samples.some(sample => !sample)) return res.status(400).json({ error: 'Invalid startup timing sample' });
        if (!rateLimit(String(req.user._id), 'samples', samples.length)) {
            res.set('Retry-After', '3600');
            return res.status(429).json({ error: 'Startup sample limit reached' });
        }
        try {
            await Sample.bulkWrite(samples.map(({ ageDays, ...sample }) => ({ updateOne: {
                filter: { sessionId: sample.sessionId },
                update: { $setOnInsert: { ...sample, createdAt: new Date(now() - ageDays * 86400000) } },
                upsert: true
            } })), { ordered: false });
            return res.status(202).json({ accepted: samples.length });
        } catch (error) {
            // Concurrent replays may race the unique UUID index. Those attempts
            // are already stored and may safely be removed from the client queue.
            if (error.writeErrors?.length && error.writeErrors.every(item => item.code === 11000)) {
                return res.status(202).json({ accepted: samples.length });
            }
            return res.status(503).json({ error: 'Startup timing collection is temporarily unavailable' });
        }
    });
    router.get('/estimates', async (req, res) => {
        if (!rateLimit(String(req.user._id), 'reads')) {
            res.set('Retry-After', '3600');
            return res.status(429).json({ error: 'Startup estimate limit reached' });
        }
        try {
            const context = normalizeContext(req.query);
            const recent = { createdAt: { $gte: new Date(now() - 90 * 86400000) } };
            const cohort = { ...recent };
            for (const field of ['platform', 'network', 'launch', 'deviceClass']) {
                if (context[field] !== 'unknown') cohort[`context.${field}`] = context[field];
            }
            if (['true', 'false'].includes(req.query.cached)) cohort['context.cached'] = context.cached;
            const read = (query, limit) => Sample.find(query)
                .select('context outcome durationMs stages createdAt').sort({ createdAt: -1 }).limit(limit).lean();
            // Keep both nearby and broader examples so rare slow wakes still
            // have support without downloading an unbounded event feed.
            const [similar, fallback] = await Promise.all([read(cohort, 192), read(recent, 64)]);
            const unique = new Map([...similar, ...fallback].map(item => [String(item._id), item]));
            const samples = Array.from(unique.values()).map(record => timingProfile(record, now()));
            return res.json({ version: 1, samples, generatedAt: now() });
        } catch {
            return res.status(503).json({ error: 'Startup estimates are temporarily unavailable' });
        }
    });
    return router;
};
module.exports = createStartupRouter();
module.exports.createStartupRouter = createStartupRouter;
