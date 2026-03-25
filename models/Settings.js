const mongoose = require('mongoose');

const settingsSchema = new mongoose.Schema({
    type: { type: String, default: 'paymentMethods' },
    payments: { type: Array, default: [] }
}, { timestamps: true });

module.exports = mongoose.model('Settings', settingsSchema);