const mongoose = require('mongoose');

const emailLogSchema = new mongoose.Schema({
    from: { type: String, required: true },
    to: { type: String, required: true },
    subject: { type: String, default: '' },
    body: { type: String, default: '' },
    sentAt: { type: Date, default: Date.now },
    assignedTo: { type: String, default: '' },
    threadId: { type: String, default: '' },
    messageId: { type: String, default: '' },
    isFollowUp: { type: Boolean, default: false },
    opened: { type: Boolean, default: false },
    openedAt: { type: Date },
    replied: { type: Boolean, default: false },
    repliedAt: { type: Date },
    followUpDueAt: { type: Date },
    trackingPixelId: { type: String, unique: true }
}, { timestamps: true });

module.exports = mongoose.model('EmailLog', emailLogSchema);
