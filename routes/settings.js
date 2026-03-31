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