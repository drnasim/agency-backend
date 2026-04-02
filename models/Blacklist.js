const mongoose = require('mongoose');

const blacklistSchema = new mongoose.Schema({
    email: { type: String, unique: true, sparse: true, default: '' },
    domain: { type: String, default: '' },
    reason: {
        type: String,
        enum: ['bounced', 'unsubscribed', 'spam_complaint', 'manual'],
        default: 'manual'
    },
    addedAt: { type: Date, default: Date.now }
});

module.exports = mongoose.model('Blacklist', blacklistSchema);
