const mongoose = require('mongoose');

const GUIDELINE_RULE_TYPES = Object.freeze(['Must Use', 'Prefer', 'Avoid']);
const GUIDELINE_REFERENCE_TYPES = Object.freeze(['', 'link', 'image']);

const isSafeHttpUrl = (value) => {
    if (!value) return true;

    try {
        const parsedUrl = new URL(value);
        return parsedUrl.protocol === 'http:' || parsedUrl.protocol === 'https:';
    } catch {
        return false;
    }
};

const guidelineItemSchema = new mongoose.Schema({
    category: {
        type: String,
        required: [true, 'Guideline category is required'],
        trim: true,
        maxlength: [60, 'Guideline category cannot exceed 60 characters']
    },
    instruction: {
        type: String,
        required: [true, 'Guideline instruction is required'],
        trim: true,
        maxlength: [5000, 'Guideline instruction cannot exceed 5000 characters']
    },
    ruleType: {
        type: String,
        enum: GUIDELINE_RULE_TYPES,
        default: 'Prefer'
    },
    referenceType: {
        type: String,
        enum: GUIDELINE_REFERENCE_TYPES,
        default: ''
    },
    referenceUrl: {
        type: String,
        trim: true,
        default: '',
        maxlength: [2048, 'Guideline reference URL cannot exceed 2048 characters'],
        validate: {
            validator: isSafeHttpUrl,
            message: 'Guideline reference URL must use http or https'
        }
    },
    referenceName: {
        type: String,
        trim: true,
        default: '',
        maxlength: [255, 'Guideline reference name cannot exceed 255 characters']
    }
});

guidelineItemSchema.pre('validate', function normalizeReference(next) {
    if (!this.referenceUrl) {
        this.referenceType = '';
        this.referenceName = '';
    } else if (!this.referenceType) {
        this.referenceType = 'link';
    }
    next();
});

const clientSchema = new mongoose.Schema({
    name: { type: String, required: true },
    email: { type: String },
    company: { type: String },
    phone: { type: String }, // ফোন নাম্বারের জন্য
    guidelines: { type: String, default: '' },
    guidelineItems: {
        type: [guidelineItemSchema],
        default: [],
        validate: {
            validator: items => items.length <= 100,
            message: 'A client cannot have more than 100 guidelines'
        }
    },
    guidelineNotes: {
        type: String,
        trim: true,
        default: '',
        maxlength: [10000, 'Additional guideline notes cannot exceed 10000 characters']
    },
    socials: [{
        platform: { type: String },
        link: { type: String }
    }], // আনলিমিটেড সোশ্যাল মিডিয়া লিংকের জন্য
    paymentMethod: { type: String, default: 'Global Default' }
}, { timestamps: true });

module.exports = mongoose.model('Client', clientSchema);
module.exports.GUIDELINE_RULE_TYPES = GUIDELINE_RULE_TYPES;
module.exports.GUIDELINE_REFERENCE_TYPES = GUIDELINE_REFERENCE_TYPES;
module.exports.isSafeHttpUrl = isSafeHttpUrl;
