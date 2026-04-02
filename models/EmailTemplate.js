const mongoose = require('mongoose');

const emailTemplateSchema = new mongoose.Schema({
    name: { type: String, required: true },
    subject: { type: String, default: '' },
    body: { type: String, default: '' },
    category: { type: String, enum: ['cold', 'followup', 'reply'], required: true },
    createdBy: { type: String, default: '' },
    openRate: { type: Number, default: 0 },
    replyRate: { type: Number, default: 0 },
    usageCount: { type: Number, default: 0 }
}, { timestamps: true });

module.exports = mongoose.model('EmailTemplate', emailTemplateSchema);
