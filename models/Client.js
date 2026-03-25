const mongoose = require('mongoose');

const clientSchema = new mongoose.Schema({
    name: { type: String, required: true },
    email: { type: String },
    company: { type: String },
    phone: { type: String }, // ফোন নাম্বারের জন্য
    socials: [{
        platform: { type: String },
        link: { type: String }
    }], // আনলিমিটেড সোশ্যাল মিডিয়া লিংকের জন্য
    paymentMethod: { type: String, default: 'Global Default' }
}, { timestamps: true });

module.exports = mongoose.model('Client', clientSchema);