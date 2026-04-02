const mongoose = require('mongoose');

const leadSchema = new mongoose.Schema({
    email: { type: String, required: true, unique: true },
    name: { type: String, default: '' },
    company: { type: String, default: '' },
    website: { type: String, default: '' },
    niche: { type: String, default: '' },
    status: {
        type: String,
        enum: ['new', 'contacted', 'replied', 'interested', 'converted', 'unsubscribed', 'bounced'],
        default: 'new'
    },
    assignedTo: { type: String, default: '' },
    notes: { type: String, default: '' },
    lastContactedAt: { type: Date }
}, { timestamps: true });

module.exports = mongoose.model('Lead', leadSchema);
