const express = require('express');
const router = express.Router();
const Settings = require('../models/Settings'); // Railway-এর এরর এড়াতে ছোট হাতের 's' করা হলো

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

// ================= নোটিশ বোর্ডের API =================

router.get('/notice', async (req, res) => {
    try {
        let settings = await Settings.findOne({ type: 'agencyNotice' });
        let noticeText = "Welcome to Fortivus Group! Please make sure to check your assigned tasks and meet the deadlines.";
        
        if (settings && settings.payments && settings.payments.length > 0) {
            noticeText = settings.payments[0];
        }
        res.status(200).json({ notice: noticeText });
    } catch (err) { 
        res.status(500).json({ error: err.message }); 
    }
});

router.put('/notice', async (req, res) => {
    try {
        let settings = await Settings.findOne({ type: 'agencyNotice' });
        if (!settings) {
            settings = new Settings({ type: 'agencyNotice', payments: [req.body.notice] });
        } else {
            settings.payments = [req.body.notice];
        }
        await settings.save();
        res.status(200).json({ notice: req.body.notice });
    } catch (err) { 
        res.status(500).json({ error: err.message }); 
    }
});

// ================= নতুন: গুগল ড্রাইভ API কনফিগ =================

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