const mongoose = require('mongoose');

const userSchema = new mongoose.Schema({
    name: { type: String, required: true },
    email: { type: String, required: true, unique: true },
    password: { type: String, required: true },

    // ✅ role এখন array — একজন ইউজার একসাথে Admin ও Editor দুটোই হতে পারবে
    role: { 
        type: [String], 
        enum: ['Admin', 'Editor', 'Marketer'],
        default: ['Editor']
    },
    
    phone: { type: String, unique: true, sparse: true },
    dob: { type: String, default: '' },
    gender: { type: String, enum: ['Male', 'Female'], default: 'Male' },
    profilePic: { type: String, default: '' },
    // অ্যাকাউন্ট ডিলিট/ডিজেবল হলে false হবে — লগিন ব্লক হবে
    isActive: { type: Boolean, default: true },

    // ✅ মোবাইল অ্যাপের Expo Push Token — Android নোটিফিকেশনের জন্য
    expoPushToken: { type: String, default: '' }
}, { timestamps: true });

module.exports = mongoose.model('User', userSchema);