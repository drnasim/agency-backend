const mongoose = require('mongoose');

const stageSchema = new mongoose.Schema({
    startedAtMs: { type: Number, required: true },
    completedAtMs: { type: Number, required: true },
    durationMs: { type: Number, required: true },
    outcome: { type: String, enum: ['complete', 'failed', 'skipped'], required: true }
}, { _id: false });
const schema = new mongoose.Schema({
    // A fresh random UUID for each attempt, solely for retry-safe ingestion. Never
    // associate timings with an account, installation, IP, token or device model.
    sessionId: { type: String, required: true, unique: true },
    context: {
        network: { type: String, enum: ['wifi', 'cellular', 'offline', 'unknown'] },
        platform: { type: String, enum: ['android', 'ios', 'web', 'unknown'] },
        deviceClass: { type: String, enum: ['low', 'mid', 'high', 'unknown'] },
        cached: Boolean,
        launch: { type: String, enum: ['cold', 'login', 'retry', 'unknown'] },
        queue: { type: String, enum: ['none', 'small', 'large', 'unknown'] },
        alertPermission: { type: String, enum: ['granted', 'blocked', 'unknown'] },
        appVersion: String
    },
    outcome: { type: String, enum: ['online', 'offline', 'failed', 'aborted'], required: true },
    durationMs: { type: Number, required: true },
    stages: { type: Map, of: stageSchema, required: true },
    createdAt: { type: Date, default: Date.now, required: true }
}, { versionKey: false, strict: 'throw' });
schema.index({ createdAt: 1 }, { expireAfterSeconds: 90 * 24 * 60 * 60 });
schema.index({ 'context.platform': 1, 'context.network': 1, createdAt: -1 });
module.exports = mongoose.model('StartupSample', schema);
