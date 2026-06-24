const mongoose = require('mongoose');

const emailAccountSchema = new mongoose.Schema({
    label: { type: String, required: true },
    email: { type: String, required: true, unique: true },
    type: { type: String, enum: ['gmail', 'smtp'], required: true },
    provider: {
        type: String,
        enum: ['gmail', 'smtp', 'purelymail'],
        default: function defaultProvider() {
            return this.type === 'gmail' ? 'gmail' : 'smtp';
        }
    },
    domain: { type: String, default: '' },
    smtpSecurity: { type: String, enum: ['ssl_tls', 'starttls', 'none'], default: 'starttls' },
    credentials: { type: Object, default: {} },
    dailyLimit: { type: Number, default: 40 },
    sentToday: { type: Number, default: 0 },
    sentTodayDate: { type: String, default: '' },
    warmupEnabled: { type: Boolean, default: false },
    warmupDay: { type: Number, default: 1 },
    cooldownSeconds: { type: Number, default: 120 },
    isActive: { type: Boolean, default: true },
    lastSentAt: { type: Date }
}, { timestamps: true });

module.exports = mongoose.model('EmailAccount', emailAccountSchema);
