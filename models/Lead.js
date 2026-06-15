const mongoose = require('mongoose');

const leadSchema = new mongoose.Schema({
    email: { type: String, required: true, unique: true },
    firstName: { type: String, default: '' },
    lastName: { type: String, default: '' },
    name: { type: String, default: '' },
    company: { type: String, default: '' },
    website: { type: String, default: '' },
    domain: { type: String, default: '' },
    youtubeChannel: { type: String, default: '' },
    niche: { type: String, default: '' },
    status: {
        type: String,
        enum: ['new', 'contacted', 'replied', 'interested', 'converted', 'unsubscribed', 'bounced', 'spam_complaint', 'blacklisted'],
        default: 'new'
    },
    assignedTo: { type: String, default: '' },
    note: { type: String, default: '' },
    notes: { type: String, default: '' },
    lastContactedAt: { type: Date }
}, { timestamps: true });

module.exports = mongoose.model('Lead', leadSchema);
