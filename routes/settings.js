const express = require('express');
const router = express.Router();
const Settings = require('../models/Settings'); // Railway-এর এরর এড়াতে ছোট হাতের 's' করা হলো
const Client = require('../models/Client');
const { authenticate, requireAdmin } = require('../middleware/authenticate');
const { buildLegacyGuidelines } = require('../utils/clientGuidelines');
const {
    DEFAULT_GUIDELINE_CATEGORIES,
    buildGuidelineCategoryCatalog,
    createHttpError,
    getGuidelineCategoryCatalog,
    normalizeGuidelineCategoryName,
    normalizeStoredGuidelineCategories,
    validateGuidelineCategoryName
} = require('../utils/guidelineCategories');

const getGuidelineCategorySettings = async (settingsModel = Settings) => {
    return getGuidelineCategoryCatalog(settingsModel);
};

const loadWritableGuidelineCategorySettings = async (settingsModel = Settings) => {
    let settings = await settingsModel.findOne({ type: 'guidelineCategories' });
    if (!settings) {
        settings = new settingsModel({ type: 'guidelineCategories', payments: [] });
    }
    settings.payments = normalizeStoredGuidelineCategories(settings.payments);
    return settings;
};

const addGuidelineCategory = async (value, settingsModel = Settings) => {
    const name = validateGuidelineCategoryName(value);
    const settings = await loadWritableGuidelineCategorySettings(settingsModel);
    const catalog = buildGuidelineCategoryCatalog(settings.payments);

    if (catalog.some(category => category.name.toLowerCase() === name.toLowerCase())) {
        throw createHttpError(409, 'A guideline category with this name already exists');
    }

    settings.payments = [...settings.payments, name];
    await settings.save();
    return buildGuidelineCategoryCatalog(settings.payments);
};

const escapeRegex = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const renameGuidelineCategory = async (
    currentValue,
    nextValue,
    settingsModel = Settings,
    clientModel = Client
) => {
    const currentName = validateGuidelineCategoryName(currentValue);
    const nextName = validateGuidelineCategoryName(nextValue);
    const currentKey = currentName.toLowerCase();
    const nextKey = nextName.toLowerCase();

    if (DEFAULT_GUIDELINE_CATEGORIES.some(name => name.toLowerCase() === currentKey)) {
        throw createHttpError(400, 'Default guideline categories cannot be renamed');
    }

    const settings = await loadWritableGuidelineCategorySettings(settingsModel);
    const categoryIndex = settings.payments.findIndex(
        name => name.toLowerCase() === currentKey
    );
    if (categoryIndex === -1) throw createHttpError(404, 'Guideline category not found');

    const duplicate = buildGuidelineCategoryCatalog(settings.payments).some(
        category => (
            category.name.toLowerCase() === nextKey &&
            category.name.toLowerCase() !== currentKey
        )
    );
    if (duplicate) {
        throw createHttpError(409, 'A guideline category with this name already exists');
    }

    const storedCurrentName = settings.payments[categoryIndex];
    const exactCategory = new RegExp(`^${escapeRegex(storedCurrentName)}$`, 'i');
    const clients = await clientModel.find({ 'guidelineItems.category': exactCategory });

    settings.payments[categoryIndex] = nextName;
    if (typeof settings.markModified === 'function') settings.markModified('payments');
    await settings.save();

    for (const client of clients) {
        for (const item of client.guidelineItems || []) {
            if (normalizeGuidelineCategoryName(item.category).toLowerCase() === currentKey) {
                item.category = nextName;
            }
        }
        client.guidelines = buildLegacyGuidelines(
            client.guidelineItems,
            client.guidelineNotes
        );
        await client.save();
    }

    return buildGuidelineCategoryCatalog(settings.payments);
};

const deleteGuidelineCategory = async (
    value,
    settingsModel = Settings,
    clientModel = Client
) => {
    const name = validateGuidelineCategoryName(value);
    const key = name.toLowerCase();
    if (DEFAULT_GUIDELINE_CATEGORIES.some(defaultName => defaultName.toLowerCase() === key)) {
        throw createHttpError(400, 'Default guideline categories cannot be deleted');
    }

    const settings = await loadWritableGuidelineCategorySettings(settingsModel);
    const categoryIndex = settings.payments.findIndex(
        categoryName => categoryName.toLowerCase() === key
    );
    if (categoryIndex === -1) throw createHttpError(404, 'Guideline category not found');

    const storedName = settings.payments[categoryIndex];
    const exactCategory = new RegExp(`^${escapeRegex(storedName)}$`, 'i');
    if (await clientModel.exists({ 'guidelineItems.category': exactCategory })) {
        throw createHttpError(
            409,
            'This guideline category is in use and cannot be deleted'
        );
    }

    settings.payments.splice(categoryIndex, 1);
    if (typeof settings.markModified === 'function') settings.markModified('payments');
    await settings.save();
    return buildGuidelineCategoryCatalog(settings.payments);
};

const DEFAULT_LIVE_TV_CONFIG = Object.freeze({
    servers: [
        { id: 'server-1', label: 'Server 1', url: 'http://172.19.17.28/#' },
        { id: 'server-2', label: 'Server 2', url: 'http://www.tv.iptv24bd.live/#' }
    ]
});

const normalizeLiveTvConfig = (value) => {
    if (!value || !Array.isArray(value.servers)) return null;
    if (value.servers.length < 1 || value.servers.length > 20) return null;

    const ids = new Set();
    const servers = [];
    for (const server of value.servers) {
        const id = String(server?.id || '').trim();
        const label = String(server?.label || '').trim();
        const url = String(server?.url || '').trim();
        if (!/^[a-zA-Z0-9_-]{1,80}$/.test(id) || ids.has(id) || !label || label.length > 60 || url.length > 2048) return null;
        try {
            const parsedUrl = new URL(url);
            if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') return null;
        } catch {
            return null;
        }
        ids.add(id);
        servers.push({ id, label, url });
    }
    return { servers };
};

router.get('/live-tv', authenticate, async (req, res) => {
    try {
        const settings = await Settings.findOne({ type: 'liveTvConfig' }).lean();
        const savedConfig = normalizeLiveTvConfig(settings?.payments?.[0]);
        return res.json(savedConfig || DEFAULT_LIVE_TV_CONFIG);
    } catch (err) {
        return res.status(500).json({ error: err.message });
    }
});

router.put('/live-tv', authenticate, requireAdmin, async (req, res) => {
    const config = normalizeLiveTvConfig(req.body);
    if (!config) return res.status(400).json({ error: 'A valid Live TV server configuration is required' });

    try {
        await Settings.findOneAndUpdate(
            { type: 'liveTvConfig' },
            { $set: { payments: [config] } },
            { upsert: true, runValidators: true, setDefaultsOnInsert: true }
        );
        return res.json(config);
    } catch (err) {
        return res.status(500).json({ error: err.message });
    }
});

router.get('/guideline-categories', async (req, res) => {
    try {
        const categories = await getGuidelineCategorySettings();
        return res.status(200).json({ categories });
    } catch (err) {
        return res.status(500).json({ error: err.message });
    }
});

router.post('/guideline-categories', authenticate, requireAdmin, async (req, res) => {
    try {
        const categories = await addGuidelineCategory(req.body?.name);
        return res.status(201).json({ categories });
    } catch (err) {
        return res.status(err.statusCode || 500).json({ error: err.message });
    }
});

router.put('/guideline-categories/:name', authenticate, requireAdmin, async (req, res) => {
    try {
        const categories = await renameGuidelineCategory(
            req.params.name,
            req.body?.name
        );
        return res.status(200).json({ categories });
    } catch (err) {
        return res.status(err.statusCode || 500).json({ error: err.message });
    }
});

router.delete('/guideline-categories/:name', authenticate, requireAdmin, async (req, res) => {
    try {
        const categories = await deleteGuidelineCategory(req.params.name);
        return res.status(200).json({ categories });
    } catch (err) {
        return res.status(err.statusCode || 500).json({ error: err.message });
    }
});

// ডাটাবেস থেকে পেমেন্ট মেথডগুলো দেখার API
router.get('/payments', async (req, res) => {
    try {
        let settings = await Settings.findOne({ type: 'paymentMethods' });
        if (!settings) {
            settings = new Settings({ type: 'paymentMethods', payments: [] });
            await settings.save();
        }
        res.status(200).json(settings.payments);
    } catch (err) { 
        res.status(500).json({ error: err.message }); 
    }
});

// ডাটাবেসে নতুন পেমেন্ট মেথড সেভ বা আপডেট করার API
router.put('/payments', async (req, res) => {
    try {
        let settings = await Settings.findOne({ type: 'paymentMethods' });
        if (!settings) {
            settings = new Settings({ type: 'paymentMethods', payments: req.body.payments });
        } else {
            settings.payments = req.body.payments;
        }
        await settings.save();
        res.status(200).json(settings.payments);
    } catch (err) { 
        res.status(500).json({ error: err.message }); 
    }
});

// ================= নোটিশ বোর্ডের API (Advanced Logic) =================

router.get('/notice', async (req, res) => {
    try {
        let settings = await Settings.findOne({ type: 'agencyNotice' });
        let defaultNotice = "Welcome to Fortivus Group! Please make sure to check your assigned tasks and meet the deadlines.";
        
        let noticeObj = { text: defaultNotice, daysLimit: "", scheduledDate: "" };
        
        if (settings && settings.payments && settings.payments.length > 0) {
            const savedNotice = settings.payments[0];
            
            // পুরনো ফরমেট সাপোর্ট করার জন্য (যদি স্ট্রিং থাকে)
            if (typeof savedNotice === 'string') {
                noticeObj.text = savedNotice;
            } else {
                noticeObj = { ...savedNotice };
                const now = new Date();
                
                // Expiration Check (অটোমেটিক নোট রিমুভ করার লজিক)
                if (noticeObj.daysLimit) {
                    // যদি শিডিউল ডেট থাকে তাহলে সেখান থেকে, না হলে পাবলিশ হওয়ার দিন থেকে কাউন্ট শুরু হবে
                    const startDate = noticeObj.scheduledDate ? new Date(noticeObj.scheduledDate) : new Date(noticeObj.publishedAt || now);
                    const expirationDate = new Date(startDate);
                    expirationDate.setDate(expirationDate.getDate() + parseInt(noticeObj.daysLimit));
                    
                    // যদি আজকের তারিখ এক্সপায়ার ডেট পার করে ফেলে
                    if (now > expirationDate) {
                        noticeObj = { text: defaultNotice, daysLimit: "", scheduledDate: "" };
                        settings.payments = [noticeObj];
                        await settings.save(); // ডাটাবেস থেকে ডিলিট করে ডিফল্ট সেভ করা হলো
                    }
                }
            }
        }
        res.status(200).json({ notice: noticeObj });
    } catch (err) { 
        res.status(500).json({ error: err.message }); 
    }
});

router.put('/notice', async (req, res) => {
    try {
        let settings = await Settings.findOne({ type: 'agencyNotice' });
        
        const newNoticePayload = {
            text: req.body.notice.text || req.body.notice,
            daysLimit: req.body.notice.daysLimit || "",
            scheduledDate: req.body.notice.scheduledDate || "",
            publishedAt: new Date().toISOString() // রিয়েল টাইম সেভ রাখা হলো
        };

        if (!settings) {
            settings = new Settings({ type: 'agencyNotice', payments: [newNoticePayload] });
        } else {
            settings.payments = [newNoticePayload];
        }
        await settings.save();
        res.status(200).json({ notice: newNoticePayload });
    } catch (err) { 
        res.status(500).json({ error: err.message }); 
    }
});

// ================= গুগল ড্রাইভ API কনফিগ =================

// ড্রাইভ কনফিগ দেখার API
router.get('/drive', async (req, res) => {
    try {
        let settings = await Settings.findOne({ type: 'driveConfig' });
        let config = { apiKey: '', clientId: '', clientSecret: '', mainFolderId: '' };
        
        if (settings && settings.payments && settings.payments.length > 0) {
            config = settings.payments[0];
        }
        res.status(200).json(config);
    } catch (err) { 
        res.status(500).json({ error: err.message }); 
    }
});

// ড্রাইভ কনফিগ সেভ বা আপডেট করার API
router.put('/drive', async (req, res) => {
    try {
        let settings = await Settings.findOne({ type: 'driveConfig' });
        if (!settings) {
            settings = new Settings({ type: 'driveConfig', payments: [req.body] });
        } else {
            settings.payments = [req.body];
        }
        await settings.save();
        res.status(200).json(settings.payments[0]);
    } catch (err) { 
        res.status(500).json({ error: err.message }); 
    }
});

module.exports = router;
module.exports.DEFAULT_GUIDELINE_CATEGORIES = DEFAULT_GUIDELINE_CATEGORIES;
module.exports.addGuidelineCategory = addGuidelineCategory;
module.exports.buildGuidelineCategoryCatalog = buildGuidelineCategoryCatalog;
module.exports.deleteGuidelineCategory = deleteGuidelineCategory;
module.exports.getGuidelineCategorySettings = getGuidelineCategorySettings;
module.exports.normalizeLiveTvConfig = normalizeLiveTvConfig;
module.exports.normalizeGuidelineCategoryName = normalizeGuidelineCategoryName;
module.exports.normalizeStoredGuidelineCategories = normalizeStoredGuidelineCategories;
module.exports.renameGuidelineCategory = renameGuidelineCategory;
module.exports.requireAdmin = requireAdmin;
