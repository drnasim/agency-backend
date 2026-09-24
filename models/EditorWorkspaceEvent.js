const mongoose = require('mongoose');

// A small catch-up feed, independent of push delivery. Never store briefs,
// client resources, or the next editor's identity in a removal receipt.
const schema = new mongoose.Schema({
    userId: { type: mongoose.Schema.Types.ObjectId, required: true },
    eventId: { type: String, required: true },
    data: { type: mongoose.Schema.Types.Mixed, required: true },
    createdAt: { type: Date, default: Date.now }
});
schema.index({ userId: 1, eventId: 1 }, { unique: true });
schema.index({ userId: 1, createdAt: -1 });
schema.index({ createdAt: 1 }, { expireAfterSeconds: 90 * 24 * 60 * 60 });
module.exports = mongoose.model('EditorWorkspaceEvent', schema);
