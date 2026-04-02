const express = require('express');
const router = express.Router();
const nodemailer = require('nodemailer');
const { google } = require('googleapis');
const { v4: uuidv4 } = require('uuid');

const EmailAccount = require('../models/EmailAccount');
const Lead = require('../models/Lead');
const EmailLog = require('../models/EmailLog');
const EmailTemplate = require('../models/EmailTemplate');
const SalesTarget = require('../models/SalesTarget');
const Blacklist = require('../models/Blacklist');

const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const GOOGLE_REDIRECT_URI = process.env.GOOGLE_REDIRECT_URI || 'http://localhost:8080/api/mail/oauth/callback';
const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:5173';

// ====================== EMAIL ACCOUNTS ======================

router.get('/accounts', async (req, res) => {
    try {
        const accounts = await EmailAccount.find().sort({ createdAt: -1 });
        res.json(accounts);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

router.post('/accounts', async (req, res) => {
    try {
        const { label, email, host, port, user, pass } = req.body;
        const account = new EmailAccount({
            label,
            email,
            type: 'smtp',
            credentials: { host, port, user, pass }
        });
        const saved = await account.save();
        res.status(201).json(saved);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

router.delete('/accounts/:id', async (req, res) => {
    try {
        await EmailAccount.findByIdAndDelete(req.params.id);
        res.json({ message: 'Account deleted' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ====================== GOOGLE OAUTH ======================

router.get('/oauth/google', (req, res) => {
    if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET) {
        return res.status(500).json({ error: 'Google OAuth credentials not configured.' });
    }
    const oauth2Client = new google.auth.OAuth2(GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REDIRECT_URI);
    const url = oauth2Client.generateAuthUrl({
        access_type: 'offline',
        scope: [
            'https://mail.google.com/',
            'https://www.googleapis.com/auth/userinfo.email'
        ],
        prompt: 'consent'
    });
    res.json({ url });
});

router.get('/oauth/callback', async (req, res) => {
    const { code } = req.query;
    if (!code) return res.status(400).send('No auth code received.');
    try {
        const oauth2Client = new google.auth.OAuth2(GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REDIRECT_URI);
        const { tokens } = await oauth2Client.getToken(code);
        oauth2Client.setCredentials(tokens);

        const oauth2 = google.oauth2({ version: 'v2', auth: oauth2Client });
        const { data } = await oauth2.userinfo.get();
        const userEmail = data.email;

        let account = await EmailAccount.findOne({ email: userEmail });
        if (account) {
            account.credentials = {
                accessToken: tokens.access_token,
                refreshToken: tokens.refresh_token || account.credentials.refreshToken,
                clientId: GOOGLE_CLIENT_ID,
                clientSecret: GOOGLE_CLIENT_SECRET
            };
            account.type = 'gmail';
            account.isActive = true;
            await account.save();
        } else {
            account = new EmailAccount({
                label: userEmail,
                email: userEmail,
                type: 'gmail',
                credentials: {
                    accessToken: tokens.access_token,
                    refreshToken: tokens.refresh_token,
                    clientId: GOOGLE_CLIENT_ID,
                    clientSecret: GOOGLE_CLIENT_SECRET
                }
            });
            await account.save();
        }
        res.redirect(`${FRONTEND_URL}/admin-mail?oauth=success`);
    } catch (err) {
        console.error('OAuth callback error:', err.message);
        res.redirect(`${FRONTEND_URL}/admin-mail?oauth=error`);
    }
});

// ====================== EMAIL SENDING ======================

const getTransporter = async (account) => {
    if (account.type === 'gmail') {
        const oauth2Client = new google.auth.OAuth2(
            account.credentials.clientId || GOOGLE_CLIENT_ID,
            account.credentials.clientSecret || GOOGLE_CLIENT_SECRET,
            GOOGLE_REDIRECT_URI
        );
        oauth2Client.setCredentials({
            access_token: account.credentials.accessToken,
            refresh_token: account.credentials.refreshToken
        });
        const { token } = await oauth2Client.getAccessToken();
        return nodemailer.createTransport({
            service: 'gmail',
            auth: {
                type: 'OAuth2',
                user: account.email,
                clientId: account.credentials.clientId || GOOGLE_CLIENT_ID,
                clientSecret: account.credentials.clientSecret || GOOGLE_CLIENT_SECRET,
                refreshToken: account.credentials.refreshToken,
                accessToken: token
            }
        });
    } else {
        return nodemailer.createTransport({
            host: account.credentials.host,
            port: Number(account.credentials.port) || 587,
            secure: Number(account.credentials.port) === 465,
            auth: {
                user: account.credentials.user,
                pass: account.credentials.pass
            }
        });
    }
};

router.post('/send', async (req, res) => {
    const { from, to, subject, body, templateId, isFollowUp, assignedTo } = req.body;
    if (!from || !to || !subject || !body) {
        return res.status(400).json({ error: 'from, to, subject, body are required.' });
    }

    try {
        // Blacklist চেক
        const toEmail = to.trim().toLowerCase();
        const toDomain = toEmail.split('@')[1];
        const blocked = await Blacklist.findOne({
            $or: [
                { email: toEmail },
                { domain: toDomain }
            ]
        });
        if (blocked) return res.status(400).json({ error: `Recipient is blacklisted (${blocked.reason}).` });

        // Account খোঁজা
        const account = await EmailAccount.findOne({ email: from, isActive: true });
        if (!account) return res.status(404).json({ error: 'Sending account not found or inactive.' });

        // Daily limit চেক
        if (account.sentToday >= account.dailyLimit) {
            return res.status(429).json({ error: `Daily limit of ${account.dailyLimit} reached for ${from}.` });
        }

        // Warm-up limit চেক
        if (account.warmupEnabled) {
            const warmupLimit = Math.min(account.warmupDay * 5, 40);
            if (account.sentToday >= warmupLimit) {
                return res.status(429).json({ error: `Warm-up limit of ${warmupLimit} reached today (Day ${account.warmupDay}).` });
            }
        }

        // Tracking pixel ID
        const trackingPixelId = uuidv4();

        // Follow-up due = sentAt + 3 days
        const sentAt = new Date();
        const followUpDueAt = new Date(sentAt.getTime() + 3 * 24 * 60 * 60 * 1000);

        // Random delay 2–5 minutes then send
        const delayMs = Math.floor(Math.random() * (5 - 2 + 1) + 2) * 60 * 1000;

        // Log তৈরি করে সাথে সাথে response দেওয়া
        const log = new EmailLog({
            from,
            to: toEmail,
            subject,
            body,
            sentAt,
            assignedTo: assignedTo || '',
            isFollowUp: !!isFollowUp,
            followUpDueAt,
            trackingPixelId
        });
        await log.save();

        // Template usageCount++
        if (templateId) {
            await EmailTemplate.findByIdAndUpdate(templateId, { $inc: { usageCount: 1 } });
        }

        // sentToday++
        await EmailAccount.findByIdAndUpdate(account._id, { $inc: { sentToday: 1 } });

        // Lead status আপডেট
        await Lead.findOneAndUpdate(
            { email: toEmail },
            { status: 'contacted', lastContactedAt: sentAt },
            { upsert: false }
        );

        res.json({ message: 'Email queued for sending.', delayMinutes: Math.round(delayMs / 60000), logId: log._id });

        // Delayed actual send
        setTimeout(async () => {
            try {
                const transporter = await getTransporter(account);
                const BACKEND_URL = process.env.BACKEND_URL || 'http://localhost:8080';
                const bodyWithPixel = body + `<img src="${BACKEND_URL}/api/mail/track/${trackingPixelId}" width="1" height="1" style="display:none;" />`;

                const info = await transporter.sendMail({
                    from: `"${account.label}" <${account.email}>`,
                    to: toEmail,
                    subject,
                    html: bodyWithPixel
                });

                await EmailLog.findByIdAndUpdate(log._id, {
                    messageId: info.messageId || '',
                    threadId: info.threadId || ''
                });
            } catch (sendErr) {
                console.error('Delayed send error:', sendErr.message);
                // Bounce হলে blacklist করা
                if (sendErr.responseCode >= 500) {
                    await Blacklist.findOneAndUpdate(
                        { email: toEmail },
                        { email: toEmail, domain: toDomain, reason: 'bounced' },
                        { upsert: true }
                    );
                    await Lead.findOneAndUpdate({ email: toEmail }, { status: 'bounced' });
                }
            }
        }, delayMs);

    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ====================== INBOX (REPLIES) ======================

router.get('/inbox/:salesmanEmail', async (req, res) => {
    try {
        const { salesmanEmail } = req.params;
        const target = await SalesTarget.findOne({ salesmanEmail }).populate('assignedAccounts');
        if (!target) return res.json([]);

        const allReplies = [];

        for (const account of target.assignedAccounts) {
            if (account.type !== 'gmail' || !account.credentials.refreshToken) continue;
            try {
                const oauth2Client = new google.auth.OAuth2(
                    account.credentials.clientId || GOOGLE_CLIENT_ID,
                    account.credentials.clientSecret || GOOGLE_CLIENT_SECRET,
                    GOOGLE_REDIRECT_URI
                );
                oauth2Client.setCredentials({
                    access_token: account.credentials.accessToken,
                    refresh_token: account.credentials.refreshToken
                });

                const gmail = google.gmail({ version: 'v1', auth: oauth2Client });
                const listRes = await gmail.users.messages.list({
                    userId: 'me',
                    labelIds: ['INBOX'],
                    maxResults: 50
                });

                const messages = listRes.data.messages || [];
                for (const msg of messages) {
                    const detail = await gmail.users.messages.get({ userId: 'me', id: msg.id, format: 'metadata', metadataHeaders: ['From', 'Subject', 'Date'] });
                    const headers = detail.data.payload.headers;
                    const getHeader = (name) => (headers.find(h => h.name.toLowerCase() === name.toLowerCase()) || {}).value || '';

                    const threadId = detail.data.threadId;
                    const fromHeader = getHeader('From');
                    const subject = getHeader('Subject');
                    const date = getHeader('Date');

                    // threadId দিয়ে log match করে replied সেট করা
                    const log = await EmailLog.findOneAndUpdate(
                        { threadId, replied: false },
                        { replied: true, repliedAt: new Date() },
                        { new: true }
                    );

                    allReplies.push({
                        messageId: msg.id,
                        threadId,
                        from: fromHeader,
                        subject,
                        date,
                        account: account.email,
                        logUpdated: !!log
                    });
                }
            } catch (gmailErr) {
                console.error(`Gmail poll error for ${account.email}:`, gmailErr.message);
            }
        }

        // SMTP accounts — stored logs থেকে replied দেখানো
        const smtpReplies = await EmailLog.find({
            from: { $in: target.assignedAccounts.map(a => a.email) },
            replied: true
        }).sort({ repliedAt: -1 }).limit(50);

        res.json({ gmailReplies: allReplies, smtpReplies });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ====================== OPEN TRACKING ======================

router.get('/track/:pixelId', async (req, res) => {
    try {
        await EmailLog.findOneAndUpdate(
            { trackingPixelId: req.params.pixelId, opened: false },
            { opened: true, openedAt: new Date() }
        );
    } catch (err) {
        console.error('Tracking error:', err.message);
    }
    // 1x1 transparent GIF
    const pixel = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');
    res.set('Content-Type', 'image/gif');
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');
    res.send(pixel);
});

// ====================== FOLLOW-UPS ======================

router.get('/followups/:salesmanEmail', async (req, res) => {
    try {
        const now = new Date();
        const logs = await EmailLog.find({
            assignedTo: req.params.salesmanEmail,
            replied: false,
            followUpDueAt: { $lte: now }
        }).sort({ followUpDueAt: 1 });
        res.json(logs);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ====================== LEADS ======================

router.get('/leads', async (req, res) => {
    try {
        const filter = {};
        if (req.query.status) filter.status = req.query.status;
        if (req.query.assignedTo) filter.assignedTo = req.query.assignedTo;
        const leads = await Lead.find(filter).sort({ createdAt: -1 });
        res.json(leads);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

router.post('/leads', async (req, res) => {
    try {
        const lead = new Lead(req.body);
        const saved = await lead.save();
        res.status(201).json(saved);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

router.post('/leads/bulk', async (req, res) => {
    try {
        const { leads } = req.body;
        if (!Array.isArray(leads) || leads.length === 0) {
            return res.status(400).json({ error: 'leads array is required.' });
        }
        const results = { inserted: 0, skipped: 0, errors: [] };
        for (const lead of leads) {
            if (!lead.email) { results.skipped++; continue; }
            try {
                await Lead.findOneAndUpdate(
                    { email: lead.email.trim().toLowerCase() },
                    { ...lead, email: lead.email.trim().toLowerCase() },
                    { upsert: true, new: true }
                );
                results.inserted++;
            } catch (e) {
                results.skipped++;
                results.errors.push(lead.email);
            }
        }
        res.json(results);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

router.put('/leads/:id', async (req, res) => {
    try {
        const updated = await Lead.findByIdAndUpdate(req.params.id, req.body, { new: true });
        res.json(updated);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

router.delete('/leads/:id', async (req, res) => {
    try {
        await Lead.findByIdAndDelete(req.params.id);
        res.json({ message: 'Lead deleted' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ====================== TEMPLATES ======================

router.get('/templates', async (req, res) => {
    try {
        const templates = await EmailTemplate.find().sort({ createdAt: -1 });
        res.json(templates);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

router.post('/templates', async (req, res) => {
    try {
        const template = new EmailTemplate(req.body);
        const saved = await template.save();
        res.status(201).json(saved);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

router.put('/templates/:id', async (req, res) => {
    try {
        const updated = await EmailTemplate.findByIdAndUpdate(req.params.id, req.body, { new: true });
        res.json(updated);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

router.delete('/templates/:id', async (req, res) => {
    try {
        await EmailTemplate.findByIdAndDelete(req.params.id);
        res.json({ message: 'Template deleted' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ====================== SALES TARGETS ======================

router.get('/targets', async (req, res) => {
    try {
        const targets = await SalesTarget.find().populate('assignedAccounts').sort({ createdAt: -1 });
        res.json(targets);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

router.post('/targets', async (req, res) => {
    try {
        const target = new SalesTarget(req.body);
        const saved = await target.save();
        res.status(201).json(saved);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

router.put('/targets/:id', async (req, res) => {
    try {
        const updated = await SalesTarget.findByIdAndUpdate(req.params.id, req.body, { new: true });
        res.json(updated);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ====================== STATS ======================

router.get('/stats/:salesmanEmail', async (req, res) => {
    try {
        const { salesmanEmail } = req.params;
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        const tomorrow = new Date(today);
        tomorrow.setDate(tomorrow.getDate() + 1);

        const target = await SalesTarget.findOne({ salesmanEmail });

        const [sentToday, repliedToday, pendingFollowUps] = await Promise.all([
            EmailLog.countDocuments({ assignedTo: salesmanEmail, sentAt: { $gte: today, $lt: tomorrow } }),
            EmailLog.countDocuments({ assignedTo: salesmanEmail, replied: true, repliedAt: { $gte: today, $lt: tomorrow } }),
            EmailLog.countDocuments({ assignedTo: salesmanEmail, replied: false, followUpDueAt: { $lte: new Date() } })
        ]);

        res.json({
            salesmanEmail,
            sentToday,
            targetPerDay: target?.targetPerDay || 0,
            repliedToday,
            pendingFollowUps,
            remaining: Math.max(0, (target?.targetPerDay || 0) - sentToday)
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

router.get('/admin/stats', async (req, res) => {
    try {
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        const tomorrow = new Date(today);
        tomorrow.setDate(tomorrow.getDate() + 1);

        const targets = await SalesTarget.find().populate('assignedAccounts');
        const summaries = await Promise.all(targets.map(async (t) => {
            const [sentToday, repliedToday, newReplies] = await Promise.all([
                EmailLog.countDocuments({ assignedTo: t.salesmanEmail, sentAt: { $gte: today, $lt: tomorrow } }),
                EmailLog.countDocuments({ assignedTo: t.salesmanEmail, replied: true }),
                EmailLog.countDocuments({ assignedTo: t.salesmanEmail, replied: true, repliedAt: { $gte: today, $lt: tomorrow } })
            ]);
            return {
                salesmanEmail: t.salesmanEmail,
                salesmanName: t.salesmanName,
                targetPerDay: t.targetPerDay,
                sentToday,
                repliedToday,
                newReplies,
                assignedAccounts: t.assignedAccounts
            };
        }));
        res.json(summaries);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ====================== BLACKLIST ======================

router.get('/blacklist', async (req, res) => {
    try {
        const list = await Blacklist.find().sort({ addedAt: -1 });
        res.json(list);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

router.post('/blacklist', async (req, res) => {
    try {
        const entry = new Blacklist(req.body);
        const saved = await entry.save();
        res.status(201).json(saved);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

router.delete('/blacklist/:id', async (req, res) => {
    try {
        await Blacklist.findByIdAndDelete(req.params.id);
        res.json({ message: 'Removed from blacklist' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

module.exports = router;
