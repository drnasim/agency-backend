const mongoose = require('mongoose');

const userSchema = new mongoose.Schema({
    name: { type: String, required: true },
    email: { type: String, required: true, unique: true },
    password: { type: String, required: true },
    role: { type: String, enum: ['Admin', 'Editor'], default: 'Editor' },
    
    // নতুন অ্যাড করা প্রোফাইল ফিল্ডগুলো
    phone: { type: String, unique: true, sparse: true }, // ইউনিক করা হলো
    dob: { type: String, default: '' },
    gender: { type: String, enum: ['Male', 'Female'], default: 'Male' },
    profilePic: { type: String, default: '' }
}, { timestamps: true });

module.exports = mongoose.model('User', userSchema);