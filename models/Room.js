const mongoose = require('mongoose');

const roomSchema = new mongoose.Schema({
    name: { type: String, required: true }, // গ্রুপের নাম বা 1-on-1 চ্যাটের ক্ষেত্রে ইউজারের নাম
    isGroup: { type: Boolean, default: false }, // এটা কি গ্রুপ নাকি প্রাইভেট চ্যাট
    members: { type: Array, default: [] }, // এই রুমে কোন কোন ইউজার আছে তাদের নাম বা ইমেইল
    createdBy: { type: String, required: true } // কে গ্রুপটা বানিয়েছে
}, { timestamps: true });

module.exports = mongoose.model('Room', roomSchema);