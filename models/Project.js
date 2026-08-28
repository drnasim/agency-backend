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
    assignedEditorUserId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        default: null,
        index: true
    },

    // Project work status and assignment-acceptance status are intentionally
    // separate. A project may remain "Pending" while its editor has already
    // accepted the assignment request.
    priority: {
        type: String,
        enum: ['Low', 'Normal', 'High', 'Urgent'],
        default: 'Normal'
    },
    assignmentStatus: {
        type: String,
        enum: ['pending', 'accepted'],
        default: null,
        index: true
    },
    assignmentRequestId: { type: String, default: null },
    assignmentVersion: { type: Number, default: 0, min: 0 },
    assignedAt: { type: Date, default: null },
    deliveredAt: { type: Date, default: null },
    acceptedAt: { type: Date, default: null },
    // This is the end of the call-style ringing window, not the end of the
    // assignment. A pending assignment remains accept-able after this time.
    assignmentExpiresAt: { type: Date, default: null },
    acceptedBy: {
        userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
        name: { type: String, default: '' }
    },
    
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
    createdByUserId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    createdBy: { type: String, default: '' },
    createdByEmail: { type: String, default: '' },
    finalVideoLink: { type: String, default: '' },
    adminFeedback: { type: String, default: '' }
}, { timestamps: true });

projectSchema.index({ assignedEditorUserId: 1, assignmentStatus: 1, assignedAt: 1 });
projectSchema.index(
    { assignmentRequestId: 1 },
    { unique: true, partialFilterExpression: { assignmentRequestId: { $type: 'string' } } }
);

module.exports = mongoose.model('Project', projectSchema);
