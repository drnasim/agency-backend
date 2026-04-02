const mongoose = require('mongoose');

const salesTargetSchema = new mongoose.Schema({
    salesmanEmail: { type: String, required: true },
    salesmanName: { type: String, default: '' },
    targetPerDay: { type: Number, default: 20 },
    assignedAccounts: [{ type: mongoose.Schema.Types.ObjectId, ref: 'EmailAccount' }]
}, { timestamps: true });

module.exports = mongoose.model('SalesTarget', salesTargetSchema);
