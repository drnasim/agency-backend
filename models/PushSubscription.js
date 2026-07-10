const mongoose = require('mongoose');

const pushSubscriptionSchema = new mongoose.Schema({
    userId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: true,
        index: true
    },
    endpoint: {
        type: String,
        required: true,
        trim: true
    },
    keys: {
        p256dh: { type: String, required: true },
        auth: { type: String, required: true }
    },
    enabled: { type: Boolean, default: true, index: true },
    lastSeenAt: { type: Date, default: Date.now },
    userAgent: { type: String, default: '', maxlength: 500 },
    deviceLabel: { type: String, default: '', maxlength: 120 },
    provider: { type: String, default: 'web-push', enum: ['web-push'] }
}, { timestamps: true });

pushSubscriptionSchema.index({ userId: 1, enabled: 1 });
pushSubscriptionSchema.index(
    { endpoint: 1 },
    { unique: true, partialFilterExpression: { endpoint: { $type: 'string' } } }
);

pushSubscriptionSchema.methods.toWebPushSubscription = function toWebPushSubscription() {
    return {
        endpoint: this.endpoint,
        keys: {
            p256dh: this.keys.p256dh,
            auth: this.keys.auth
        }
    };
};

module.exports = mongoose.model('PushSubscription', pushSubscriptionSchema);
