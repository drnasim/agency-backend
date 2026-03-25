const mongoose = require('mongoose');

const projectSchema = new mongoose.Schema({
    title: { type: String, required: true },
    client: { type: String },
    projectType: { type: String },
    budget: { type: Number },
    assignedEditor: { type: String },
    
    // নতুন মাল্টিপল রিসোর্স সিস্টেম
    resources: [{
        type: { type: String }, // Raw Footage, Voice Over, Script etc.
        name: { type: String }, // e.g., 'Cam A', 'Main Script'
        link: { type: String }
    }],

    status: { type: String, default: 'Pending' },
    paymentStatus: { type: String, default: 'Unpaid' },
    deadline: { type: Date },
    notes: { type: String },
    finalVideoLink: { type: String, default: '' },
    adminFeedback: { type: String, default: '' }
}, { timestamps: true });

module.exports = mongoose.model('Project', projectSchema);