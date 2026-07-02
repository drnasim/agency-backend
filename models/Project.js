const mongoose = require('mongoose');

const projectSchema = new mongoose.Schema({
    title: { type: String, required: true },
    client: { type: String },
    projectType: { type: String },
    budget: { type: Number },
    budgetType: { type: String, default: 'Fixed Budget' },
    perMinuteRate: { type: Number, default: 0 },
    durationMinutes: { type: Number, default: 0 },
    durationSeconds: { type: Number, default: 0 },
    billableMinutes: { type: Number, default: 0 },
    assignedEditor: { type: String },
    editor: { type: String }, // ফিল্টারিংয়ের জন্য নতুন যুক্ত করা হলো
    
    // নতুন মাল্টিপল রিসোর্স সিস্টেম
    resources: [{
        type: { type: String }, // Raw Footage, Voice Over, Script etc.
        name: { type: String }, // e.g., 'Cam A', 'Main Script'
        link: { type: String }
    }],

    status: { type: String, default: 'Pending' },
    paymentStatus: { type: String, default: 'Unpaid' },
    completedAt: { type: Date },
    deadline: { type: Date },
    notes: { type: String },
    createdBy: { type: String, default: '' },
    createdByEmail: { type: String, default: '' },
    finalVideoLink: { type: String, default: '' },
    adminFeedback: { type: String, default: '' }
}, { timestamps: true });

module.exports = mongoose.model('Project', projectSchema);
