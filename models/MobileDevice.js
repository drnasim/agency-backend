const mongoose = require('mongoose');

const mobileDeviceSchema = new mongoose.Schema({
    userId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: true,
        index: true
    },
    installationId: {
        type: String,
        required: true,
        trim: true,
        maxlength: 200
    },
    fcmToken: {
        type: String,
        required: true,
        trim: true,
        maxlength: 4096
    },
    platform: {
        type: String,
        enum: ['android'],
        default: 'android'
    },
    enabled: { type: Boolean, default: true, index: true },
    lastSeenAt: { type: Date, default: Date.now },
    deviceLabel: { type: String, default: '', maxlength: 120 },
    appVersion: { type: String, default: '', maxlength: 50 }
}, { timestamps: true });

mobileDeviceSchema.index({ installationId: 1 }, { unique: true });
mobileDeviceSchema.index({ fcmToken: 1 }, { unique: true });
mobileDeviceSchema.index({ userId: 1, enabled: 1, lastSeenAt: -1 });

module.exports = mongoose.model('MobileDevice', mobileDeviceSchema);
