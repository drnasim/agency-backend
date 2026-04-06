const mongoose = require('mongoose');

const messageSchema = new mongoose.Schema({
    room: { type: String, required: true },
    sender: { type: String, required: true },
    text: { type: String, default: '' },
    fileUrl: { type: String, default: '' },
    time: { type: String, required: true },

    // ✅ Facebook Messenger স্টাইল মেসেজ স্ট্যাটাস
    status: {
        type: String,
        enum: ['sent', 'delivered', 'read'],
        default: 'sent'
    },
    // কাদের কাছে ডেলিভার হয়েছে (username array)
    deliveredTo: { type: [String], default: [] },
    // কারা পড়েছে (username array)
    readBy: { type: [String], default: [] },
    // ডেলিভারি ও রিড টাইমস্ট্যাম্প
    deliveredAt: { type: Date },
    readAt: { type: Date }
}, { timestamps: true });

// ✅ Unread count দ্রুত বের করার জন্য compound index
messageSchema.index({ room: 1, createdAt: 1 });
messageSchema.index({ room: 1, readBy: 1 });

module.exports = mongoose.model('Message', messageSchema);