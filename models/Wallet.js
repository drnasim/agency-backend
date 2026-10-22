const mongoose = require('mongoose');

const walletSchema = new mongoose.Schema({
    name: { type: String, required: true },
    address: { type: String, required: true },
    network: { type: String, enum: ['BTC', 'ETH', 'SOL', 'BNB'], required: true },
    createdAt: { type: Date, default: Date.now }
});

module.exports = mongoose.models.Wallet || mongoose.model('Wallet', walletSchema);
