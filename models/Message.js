const mongoose = require('mongoose');

const messageSchema = new mongoose.Schema({
    room: { type: String, required: true }, // কোন গ্রুপ বা কার সাথে চ্যাট হচ্ছে তার আইডি
    sender: { type: String, required: true }, // কে পাঠিয়েছে তার নাম
    text: { type: String, default: '' }, // মেসেজের টেক্সট
    fileUrl: { type: String, default: '' }, // যদি ইমেজ বা ফাইল পাঠায়
    time: { type: String, required: true } // পাঠানোর সময়
}, { timestamps: true });

module.exports = mongoose.model('Message', messageSchema);