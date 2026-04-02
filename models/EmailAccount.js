const mongoose = require('mongoose');

const emailAccountSchema = new mongoose.Schema({
    label: { type: String, required: true },
    email: { type: String, required: true, unique: true },
    type: { type: String, enum: ['gmail', 'smtp'], required: true },
    credentials: { type: Object, default: {} },
    dailyLimit: { type: Number, default: 40 },
    sentToday: { type: Number, default: 0 },
    warmupEnabled: { type: Boolean, default: false },
    warmupDay: { type: Number, default: 1 },
    isActive: { type: Boolean, default: true }
}, { timestamps: true });

module.exports = mongoose.model('EmailAccount', emailAccountSchema);
