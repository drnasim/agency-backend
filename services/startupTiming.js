const STAGE_IDS = Object.freeze([
    'local-state', 'backend', 'projects', 'assignments', 'notifications',
    'alerts', 'local-actions', 'realtime'
]);
const MAX_DURATION_MS = 15 * 60 * 1000;
const MAX_BATCH = 12;
const REQUIRED_STAGES = ['local-state', 'backend', 'projects', 'assignments', 'local-actions'];
const CONTEXT_ENUMS = Object.freeze({
    network: ['wifi', 'cellular', 'offline', 'unknown'],
    platform: ['android', 'ios', 'web', 'unknown'],
    deviceClass: ['low', 'mid', 'high', 'unknown'],
    launch: ['cold', 'login', 'retry', 'unknown'],
    queue: ['none', 'small', 'large', 'unknown'],
    alertPermission: ['granted', 'blocked', 'unknown']
});
const normalizeContext = (context = {}) => {
    if (!context || typeof context !== 'object' || Array.isArray(context)) context = {};
    const result = {};
    for (const [key, values] of Object.entries(CONTEXT_ENUMS)) {
        result[key] = values.includes(context[key]) ? context[key] : 'unknown';
    }
    // URL query parameters are strings; normalize GET and POST identically.
    result.cached = context.cached === true || context.cached === 'true';
    // Restrict this to release numbers; free text can accidentally carry identity.
    result.appVersion = typeof context.appVersion === 'string' && /^\d{1,3}\.\d{1,3}(?:\.\d{1,4})?$/.test(context.appVersion)
        ? context.appVersion : 'unknown';
    return result;
};
const isDuration = value => Number.isFinite(value) && value >= 0 && value <= MAX_DURATION_MS;
const validateSample = sample => {
    if (!sample || typeof sample !== 'object' || Array.isArray(sample)) return null;
    if (typeof sample.sessionId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(sample.sessionId)) return null;
    if (!['online', 'offline', 'failed', 'aborted'].includes(sample.outcome)) return null;
    if (!isDuration(sample.durationMs) || sample.durationMs < 1) return null;
    // Offline outboxes report only a coarse age, never their precise local
    // timestamp. Backdate retention so delayed uploads cannot look brand new.
    const ageDays = sample.ageDays === undefined ? 0 : sample.ageDays;
    if (!Number.isInteger(ageDays) || ageDays < 0 || ageDays > 90) return null;
    if (!sample.stages || typeof sample.stages !== 'object' || Array.isArray(sample.stages)) return null;
    const stages = {};
    for (const id of STAGE_IDS) {
        const stage = sample.stages[id];
        if (!stage) continue;
        if (!isDuration(stage.startedAtMs) || !isDuration(stage.completedAtMs) || !isDuration(stage.durationMs)) return null;
        if (!['complete', 'failed', 'skipped'].includes(stage.outcome)) return null;
        if (stage.completedAtMs < stage.startedAtMs || stage.completedAtMs > sample.durationMs) return null;
        if (Math.abs(stage.durationMs - (stage.completedAtMs - stage.startedAtMs)) > 2) return null;
        stages[id] = {
            startedAtMs: Math.round(stage.startedAtMs), completedAtMs: Math.round(stage.completedAtMs),
            durationMs: Math.round(stage.completedAtMs - stage.startedAtMs), outcome: stage.outcome
        };
    }
    // An online sample must describe the same readiness barrier as the app.
    if (sample.outcome === 'online' && !REQUIRED_STAGES.every(id => stages[id]?.outcome === 'complete')) return null;
    return {
        sessionId: sample.sessionId.toLowerCase(), context: normalizeContext(sample.context || {}),
        outcome: sample.outcome, durationMs: Math.round(sample.durationMs), stages, ageDays
    };
};
const timingProfile = (record, now = Date.now()) => {
    const round = value => Math.max(0, Math.round(value / 100) * 100);
    const stages = {};
    const source = record.stages instanceof Map ? Object.fromEntries(record.stages) : (record.stages || {});
    for (const id of STAGE_IDS) {
        if (!source[id]) continue;
        const stage = source[id];
        const startedAtMs = round(stage.startedAtMs);
        const completedAtMs = round(stage.completedAtMs);
        stages[id] = { startedAtMs, completedAtMs, durationMs: completedAtMs - startedAtMs, outcome: stage.outcome };
    }
    return {
        context: normalizeContext(record.context), outcome: record.outcome,
        durationMs: round(record.durationMs), stages,
        ageDays: Math.max(0, Math.floor((now - new Date(record.createdAt).getTime()) / 86400000))
    };
};

// The key exists only in bounded process memory for abuse control; it is never
// included in a timing document or response, and expires after one hour.
const createRateLimiter = ({ now = Date.now, maxKeys = 10000 } = {}) => {
    const buckets = new Map();
    return (key, type, amount = 1) => {
        const time = now();
        let bucket = buckets.get(key);
        if (!bucket || time - bucket.startedAt >= 3600000) {
            for (const [entry, value] of buckets) {
                if (time - value.startedAt >= 3600000) buckets.delete(entry);
            }
            if (!bucket && buckets.size >= maxKeys) return false;
            bucket = { startedAt: time, reads: 0, samples: 0 };
            buckets.set(key, bucket);
        }
        const limit = type === 'samples' ? 120 : 120;
        if (bucket[type] + amount > limit) return false;
        bucket[type] += amount;
        return true;
    };
};
module.exports = { STAGE_IDS, MAX_DURATION_MS, MAX_BATCH, normalizeContext, validateSample, timingProfile, createRateLimiter };
