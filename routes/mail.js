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
const User = require('../models/User');

const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const GOOGLE_REDIRECT_URI = process.env.GOOGLE_REDIRECT_URI || 'http://localhost:5173/api/mail/oauth/callback';

// Week-based warm-up daily limit
// Week 1 (1-7): 10, Week 2 (8-14): 20, Week 3 (15-21): 30, Week 4+ (22+): 50
const getWarmupLimit = (day) => {
    if (day <= 7)  return 10;
    if (day <= 14) return 20;
    if (day <= 21) return 30;
    return 50;
};

const PURELYMAIL_SMTP = {
    host: 'smtp.purelymail.com',
    sslPort: 465,
    startTlsPort: 587
};

const normalizeEmail = (email = '') => String(email).trim().toLowerCase();

const getEmailDomain = (email = '') => {
    const parts = normalizeEmail(email).split('@');
    return parts.length === 2 ? parts[1] : '';
};

const inferDomainFromWebsite = (value = '') => {
    const raw = String(value || '').trim();
    if (!raw) return '';
    try {
        const url = raw.startsWith('http://') || raw.startsWith('https://')
            ? new URL(raw)
            : new URL(`https://${raw}`);
        return url.hostname.replace(/^www\./i, '').toLowerCase();
    } catch {
        return raw.replace(/^https?:\/\//i, '').replace(/^www\./i, '').split('/')[0].toLowerCase();
    }
};

const normalizeLeadInput = (input = {}) => {
    const lead = { ...input };
    if (lead.email) lead.email = normalizeEmail(lead.email);
    if (lead.note !== undefined && lead.notes === undefined) lead.notes = lead.note;
    if (lead.notes !== undefined && lead.note === undefined) lead.note = lead.notes;

    const nameParts = String(lead.name || '').trim().split(/\s+/).filter(Boolean);
    if (!lead.firstName && nameParts.length) lead.firstName = nameParts[0];
    if (!lead.lastName && nameParts.length > 1) lead.lastName = nameParts.slice(1).join(' ');
    if (!lead.name && (lead.firstName || lead.lastName)) {
        lead.name = [lead.firstName, lead.lastName].filter(Boolean).join(' ');
    }
    if (!lead.domain) lead.domain = inferDomainFromWebsite(lead.website) || getEmailDomain(lead.email);
    return lead;
};

const sanitizeCredentials = (credentials = {}) => ({
    host: credentials.host || '',
    port: credentials.port || '',
    user: credentials.user || '',
    security: credentials.security || '',
    hasPassword: Boolean(credentials.pass || credentials.password),
    hasAccessToken: Boolean(credentials.accessToken || credentials.access_token),
    hasRefreshToken: Boolean(credentials.refreshToken || credentials.refresh_token),
    hasClientSecret: Boolean(credentials.clientSecret || credentials.client_secret)
});

const resolveAccountProvider = (account = {}) => {
    const data = account || {};
    return data.type === 'gmail' ? 'gmail' : (data.provider || 'smtp');
};

const sanitizeAccount = (account) => {
    if (!account) return account;
    const data = account.toObject ? account.toObject() : { ...account };
    data.provider = resolveAccountProvider(data);
    data.credentials = sanitizeCredentials(data.credentials || {});
    return data;
};

const sanitizeAccounts = (accounts = []) => accounts.map(sanitizeAccount);

const sanitizeTarget = (target) => {
    if (!target) return target;
    const data = target.toObject ? target.toObject() : { ...target };
    data.assignedAccounts = sanitizeAccounts(data.assignedAccounts || []);
    return data;
};

const getRoles = (user) => {
    if (!user) return [];
    return Array.isArray(user.role) ? user.role : [user.role].filter(Boolean);
};

const getAllowedAccountsForUser = async (userEmail) => {
    const normalizedUserEmail = normalizeEmail(userEmail);
    if (!normalizedUserEmail) {
        return { allowedAccounts: [], error: 'Sender user identity is required.' };
    }

    const user = await User.findOne({ email: normalizedUserEmail });
    if (!user || user.isActive === false) {
        return { allowedAccounts: [], error: 'Sender user not found or inactive.' };
    }

    const roles = getRoles(user);
    const hasAdmin = roles.includes('Admin');
    const hasMarketer = roles.includes('Marketer');
    const hasEditor = roles.includes('Editor');

    if ((hasAdmin && !hasEditor) || (hasAdmin && hasMarketer)) {
        return { allowedAccounts: await EmailAccount.find({ isActive: true }), user, roles };
    }

    if (hasMarketer) {
        const target = await SalesTarget.findOne({ salesmanEmail: normalizedUserEmail }).populate('assignedAccounts');
        const assignedAccounts = (target?.assignedAccounts || []).filter(account => account.isActive);
        return { allowedAccounts: assignedAccounts, user, roles };
    }

    return { allowedAccounts: [], user, roles, error: 'User is not allowed to send mail.' };
};

const findAuthorizedAccount = async ({ from, assignedTo }) => {
    const fromEmail = normalizeEmail(from);
    const account = await EmailAccount.findOne({ email: fromEmail, isActive: true });
    if (!account) {
        return { error: 'Sending account not found or inactive.', statusCode: 404 };
    }

    const { allowedAccounts, error } = await getAllowedAccountsForUser(assignedTo);
    if (error) {
        return { error, statusCode: 403 };
    }

    const isAllowed = allowedAccounts.some(allowed => {
        const allowedId = String(allowed._id || allowed);
        return allowedId === String(account._id) || normalizeEmail(allowed.email) === fromEmail;
    });

    if (!isAllowed) {
        return { error: 'Selected sender account is not assigned to this user.', statusCode: 403 };
    }

    return { account };
};

const getLeadNote = (lead = {}) => lead.note || lead.notes || '';

const getShortcodeValues = (lead = {}, account = {}) => {
    const firstName = lead.firstName || String(lead.name || '').trim().split(/\s+/)[0] || '';
    const lastName = lead.lastName || String(lead.name || '').trim().split(/\s+/).slice(1).join(' ');
    const website = lead.website || '';
    const domain = lead.domain || inferDomainFromWebsite(website) || getEmailDomain(lead.email);
    return {
        firstName,
        lastName,
        name: lead.name || [firstName, lastName].filter(Boolean).join(' '),
        company: lead.company || '',
        email: lead.email || '',
        website,
        domain,
        youtubeChannel: lead.youtubeChannel || '',
        niche: lead.niche || '',
        note: getLeadNote(lead),
        senderName: account.label || '',
        senderEmail: account.email || ''
    };
};

const renderShortcodes = (text = '', lead = {}, account = {}) => {
    const values = getShortcodeValues(lead, account);
    return String(text || '').replace(/\{\{\s*(name|company|niche|website)\s*\}\}/gi, (_, key) => values[key] || '')
        .replace(/\{(firstName|lastName|name|company|email|website|domain|youtubeChannel|niche|note|senderName|senderEmail)\}/g, (_, key) => values[key] || '');
};

const getBlockedLeadStatus = (lead) => {
    const status = String(lead?.status || '').toLowerCase();
    if (['unsubscribed', 'bounced', 'spam_complaint', 'blacklisted'].includes(status)) return status;
    return '';
};

const isAutoSenderMode = (reqBody = {}) => {
    const from = normalizeEmail(reqBody.from);
    return reqBody.senderMode === 'auto'
        || reqBody.autoSelectSender === true
        || !from
        || from === 'auto'
        || from === '__auto__';
};

const getAccountLastSentTime = (account = {}) => account.lastSentAt
    ? new Date(account.lastSentAt).getTime()
    : 0;

const getAccountSafetyState = (account = {}, now = new Date()) => {
    const reasons = [];
    const sentToday = Number(account.sentToday) || 0;
    const dailyLimit = Number.isFinite(Number(account.dailyLimit)) ? Number(account.dailyLimit) : 40;
    const warmupDay = Number(account.warmupDay) || 1;
    const warmupLimit = account.warmupEnabled ? getWarmupLimit(warmupDay) : null;
    const configuredCooldown = Number(account.cooldownSeconds);
    const cooldownSeconds = Number.isFinite(configuredCooldown) ? configuredCooldown : 120;
    const lastSentAt = account.lastSentAt ? new Date(account.lastSentAt) : null;
    const elapsedSeconds = lastSentAt ? (now.getTime() - lastSentAt.getTime()) / 1000 : null;
    const remainingSeconds = lastSentAt && cooldownSeconds > 0
        ? Math.max(0, Math.ceil(cooldownSeconds - elapsedSeconds))
        : 0;
    const effectiveLimit = warmupLimit ? Math.min(dailyLimit, warmupLimit) : dailyLimit;

    if (!account.isActive) reasons.push('Account is inactive.');
    if (dailyLimit <= 0) {
        reasons.push('Daily limit is zero.');
    } else if (sentToday >= dailyLimit) {
        reasons.push(`Daily limit of ${dailyLimit} reached.`);
    }
    if (warmupLimit && sentToday >= warmupLimit) {
        reasons.push(`Warm-up limit of ${warmupLimit} reached (Day ${warmupDay}, Week ${Math.ceil(warmupDay / 7)}).`);
    }
    if (remainingSeconds > 0) {
        reasons.push(`Cooldown active for ${remainingSeconds}s.`);
    }

    return {
        eligible: reasons.length === 0,
        reasons,
        effectiveLimit,
        dailyLimit: {
            sentToday,
            limit: dailyLimit,
            remaining: Math.max(0, dailyLimit - sentToday),
            ok: dailyLimit > 0 && sentToday < dailyLimit
        },
        warmupLimit: account.warmupEnabled ? {
            enabled: true,
            day: warmupDay,
            limit: warmupLimit,
            remaining: Math.max(0, warmupLimit - sentToday),
            ok: sentToday < warmupLimit
        } : { enabled: false, ok: true },
        cooldown: {
            seconds: cooldownSeconds,
            lastSentAt: account.lastSentAt || null,
            remainingSeconds,
            ok: remainingSeconds <= 0
        }
    };
};

const buildAccountReport = (account, now = new Date(), extraReasons = []) => {
    const safety = getAccountSafetyState(account, now);
    const reasons = [...extraReasons, ...safety.reasons];
    return {
        account,
        safeAccount: sanitizeAccount(account),
        eligible: reasons.length === 0,
        reasons,
        checks: {
            active: account.isActive !== false,
            dailyLimit: safety.dailyLimit,
            warmupLimit: safety.warmupLimit,
            cooldown: safety.cooldown,
            effectiveLimit: safety.effectiveLimit
        }
    };
};

const getRecipientSafety = async ({ toEmail, lead }) => {
    const toDomain = getEmailDomain(toEmail);
    const blocked = await Blacklist.findOne({ $or: [{ email: toEmail }, { domain: toDomain }] });
    const blockedLeadStatus = getBlockedLeadStatus(lead);
    const warnings = [];

    if (!lead) {
        warnings.push('Recipient is not an existing lead.');
    }

    if (blocked) {
        return {
            ok: false,
            blocked: true,
            blockedReason: `Recipient is blacklisted (${blocked.reason}).`,
            toEmail,
            toDomain,
            leadKnown: !!lead,
            leadStatus: lead?.status || '',
            blacklist: { reason: blocked.reason, email: blocked.email || '', domain: blocked.domain || '' },
            warnings
        };
    }

    if (blockedLeadStatus) {
        return {
            ok: false,
            blocked: true,
            blockedReason: `Lead status blocks sending (${blockedLeadStatus}).`,
            toEmail,
            toDomain,
            leadKnown: true,
            leadStatus: lead?.status || '',
            blacklist: null,
            warnings
        };
    }

    return {
        ok: true,
        blocked: false,
        blockedReason: '',
        toEmail,
        toDomain,
        leadKnown: !!lead,
        leadStatus: lead?.status || '',
        blacklist: null,
        warnings
    };
};

const chooseEligibleAccount = (reports = []) => {
    const eligible = reports.filter(report => report.eligible);
    if (!eligible.length) return null;
    return eligible.sort((a, b) => {
        const sentDiff = getAccountLastSentTime(a.account) - getAccountLastSentTime(b.account);
        if (sentDiff !== 0) return sentDiff;
        const todayDiff = (Number(a.account.sentToday) || 0) - (Number(b.account.sentToday) || 0);
        if (todayDiff !== 0) return todayDiff;
        return Math.random() - 0.5;
    })[0];
};

const getBlockedStatusCode = (reasons = []) => {
    const text = reasons.join(' ').toLowerCase();
    if (text.includes('cooldown') || text.includes('limit')) return 429;
    if (text.includes('assigned') || text.includes('allowed')) return 403;
    return 400;
};

const sentCountFilter = (base = {}) => ({
    ...base,
    $or: [
        { status: { $in: ['sent', 'opened', 'replied'] } },
        { status: { $exists: false } }
    ]
});

const makeBlockedResponse = async ({
    reqBody,
    account,
    lead,
    toEmail,
    renderedSubject,
    renderedBody,
    blockedReason,
    statusCode = 400,
    selection = null,
    suppression = null,
    accountReports = []
}) => {
    if (!reqBody.dryRun) {
        const log = new EmailLog({
            from: account?.email || normalizeEmail(reqBody.from) || 'auto',
            to: toEmail,
            subject: reqBody.subject || '',
            body: reqBody.body || '',
            renderedSubject,
            renderedBody,
            status: 'blocked',
            blockedReason,
            errorMessage: blockedReason,
            assignedTo: normalizeEmail(reqBody.assignedTo),
            isFollowUp: !!reqBody.isFollowUp,
            leadId: lead?._id,
            accountId: account?._id,
            provider: resolveAccountProvider(account),
            senderName: account?.label || '',
            senderEmail: account?.email || '',
            trackingPixelId: uuidv4()
        });
        await log.save();
    }
    return {
        statusCode,
        payload: {
            ok: false,
            dryRun: !!reqBody.dryRun,
            blocked: true,
            blockedReason,
            error: blockedReason,
            selection,
            suppression,
            accounts: {
                eligible: accountReports.filter(report => report.eligible).map(report => report.safeAccount),
                blocked: accountReports.filter(report => !report.eligible).map(report => ({
                    account: report.safeAccount,
                    reasons: report.reasons,
                    checks: report.checks
                }))
            }
        }
    };
};

const buildSelectionSummary = ({ mode, selectedReport, accountReports, reason }) => ({
    mode,
    selectedAccount: selectedReport ? selectedReport.safeAccount : null,
    reason,
    eligibleAccountsCount: accountReports.filter(report => report.eligible).length,
    blockedAccounts: accountReports.filter(report => !report.eligible).map(report => ({
        account: report.safeAccount,
        reasons: report.reasons,
        checks: report.checks
    }))
});

const runSendPreflight = async (reqBody) => {
    const from = normalizeEmail(reqBody.from);
    const assignedTo = normalizeEmail(reqBody.assignedTo);
    const autoSender = isAutoSenderMode(reqBody);
    const senderMode = autoSender ? 'auto' : 'manual';
    const leadId = reqBody.leadId || reqBody.leadID;
    let lead = leadId ? await Lead.findById(leadId) : null;
    const template = reqBody.templateId ? await EmailTemplate.findById(reqBody.templateId) : null;
    const toEmail = normalizeEmail(reqBody.to || lead?.email);
    const rawSubject = reqBody.subject || template?.subject || '';
    const rawBody = reqBody.body || template?.body || '';

    if ((!autoSender && !from) || !toEmail || !rawSubject || !rawBody) {
        return {
            error: 'sender mode/from, to/lead, subject/template, and body/template are required.',
            statusCode: 400
        };
    }

    if (!lead) lead = await Lead.findOne({ email: toEmail });
    const recipientSafety = await getRecipientSafety({ toEmail, lead });
    const accessResult = await getAllowedAccountsForUser(assignedTo);
    if (accessResult.error) {
        return { error: accessResult.error, statusCode: 403 };
    }

    const now = new Date();
    const recipientBlockReason = recipientSafety.blocked ? [recipientSafety.blockedReason] : [];
    const allowedAccounts = accessResult.allowedAccounts || [];
    const accountReports = allowedAccounts.map(account => buildAccountReport(account, now, recipientBlockReason));
    const toDomain = recipientSafety.toDomain;

    if (recipientSafety.blocked) {
        const selection = buildSelectionSummary({
            mode: senderMode,
            selectedReport: null,
            accountReports,
            reason: recipientSafety.blockedReason
        });
        return makeBlockedResponse({
            reqBody,
            account: null,
            lead,
            toEmail,
            renderedSubject: renderShortcodes(rawSubject, lead || { email: toEmail }, {}),
            renderedBody: renderShortcodes(rawBody, lead || { email: toEmail }, {}),
            blockedReason: recipientSafety.blockedReason,
            statusCode: 400,
            selection,
            suppression: recipientSafety,
            accountReports
        });
    }

    let selectedReport;
    if (autoSender) {
        selectedReport = chooseEligibleAccount(accountReports);
        if (!selectedReport) {
            const blockedReason = accountReports.length
                ? 'No eligible sender accounts are available.'
                : 'No assigned sender accounts are available.';
            const selection = buildSelectionSummary({
                mode: senderMode,
                selectedReport: null,
                accountReports,
                reason: blockedReason
            });
            return makeBlockedResponse({
                reqBody,
                account: null,
                lead,
                toEmail,
                renderedSubject: renderShortcodes(rawSubject, lead || { email: toEmail }, {}),
                renderedBody: renderShortcodes(rawBody, lead || { email: toEmail }, {}),
                blockedReason,
                statusCode: accountReports.length ? getBlockedStatusCode(accountReports.flatMap(report => report.reasons)) : 403,
                selection,
                suppression: recipientSafety,
                accountReports
            });
        }
    } else {
        selectedReport = accountReports.find(report => normalizeEmail(report.account.email) === from);
        if (!selectedReport) {
            const blockedReason = 'Selected sender account is not assigned to this user or is inactive.';
            const selection = buildSelectionSummary({
                mode: senderMode,
                selectedReport: null,
                accountReports,
                reason: blockedReason
            });
            return makeBlockedResponse({
                reqBody,
                account: null,
                lead,
                toEmail,
                renderedSubject: renderShortcodes(rawSubject, lead || { email: toEmail }, {}),
                renderedBody: renderShortcodes(rawBody, lead || { email: toEmail }, {}),
                blockedReason,
                statusCode: 403,
                selection,
                suppression: recipientSafety,
                accountReports
            });
        }
        if (!selectedReport.eligible) {
            const blockedReason = selectedReport.reasons.join(' ');
            const selection = buildSelectionSummary({
                mode: senderMode,
                selectedReport,
                accountReports,
                reason: blockedReason
            });
            const renderedSubject = renderShortcodes(rawSubject, lead || { email: toEmail }, selectedReport.account);
            const renderedBody = renderShortcodes(rawBody, lead || { email: toEmail }, selectedReport.account);
            return makeBlockedResponse({
                reqBody,
                account: selectedReport.account,
                lead,
                toEmail,
                renderedSubject,
                renderedBody,
                blockedReason,
                statusCode: getBlockedStatusCode(selectedReport.reasons),
                selection,
                suppression: recipientSafety,
                accountReports
            });
        }
    }

    const account = selectedReport.account;
    const leadForRender = lead || { email: toEmail };
    const renderedSubject = renderShortcodes(rawSubject, leadForRender, account);
    const renderedBody = renderShortcodes(rawBody, leadForRender, account);
    const selectionReason = autoSender
        ? `Auto-selected oldest eligible sender (${account.email}).`
        : `Manual sender ${account.email} passed access, daily, warm-up, cooldown, and suppression checks.`;
    const selection = buildSelectionSummary({
        mode: senderMode,
        selectedReport,
        accountReports,
        reason: selectionReason
    });

    return {
        account,
        lead,
        template,
        toEmail,
        toDomain,
        rawSubject,
        rawBody,
        renderedSubject,
        renderedBody,
        selection,
        suppression: recipientSafety,
        accountReports,
        checks: {
            senderAuthorized: true,
            senderMode,
            suppressionClear: true,
            recipient: recipientSafety,
            dailyLimit: selectedReport.checks.dailyLimit,
            warmupLimit: selectedReport.checks.warmupLimit,
            cooldown: selectedReport.checks.cooldown,
            effectiveLimit: selectedReport.checks.effectiveLimit
        }
    };
};

const reserveSenderSlot = async (account, checks = {}) => {
    const reservationAt = new Date();
    const effectiveLimit = Number.isFinite(Number(checks.effectiveLimit))
        ? Number(checks.effectiveLimit)
        : Number(account.dailyLimit) || 40;
    const cooldownSeconds = Number(checks.cooldown?.seconds) || 0;
    const filter = {
        _id: account._id,
        isActive: true,
        sentToday: { $lt: effectiveLimit }
    };

    if (cooldownSeconds > 0) {
        filter.$or = [
            { lastSentAt: { $exists: false } },
            { lastSentAt: null },
            { lastSentAt: { $lte: new Date(reservationAt.getTime() - cooldownSeconds * 1000) } }
        ];
    }

    return EmailAccount.findOneAndUpdate(
        filter,
        { $inc: { sentToday: 1 }, $set: { lastSentAt: reservationAt } },
        { new: true }
    );
};

// ====================== EMAIL ACCOUNTS ======================

router.get('/accounts', async (req, res) => {
    try {
        const { salesmanEmail } = req.query;
        if (salesmanEmail) {
            // Marketer/Salesman: শুধু assigned accounts দেখাবে
            const target = await SalesTarget.findOne({ salesmanEmail }).populate('assignedAccounts');
            if (!target) return res.json([]);
            return res.json(sanitizeAccounts(target.assignedAccounts || []));
        }
        // Admin: সব accounts
        const accounts = await EmailAccount.find().sort({ createdAt: -1 });
        res.json(sanitizeAccounts(accounts));
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

router.post('/accounts', async (req, res) => {
    try {
        const {
            label,
            email,
            host,
            port,
            user,
            pass,
            provider = 'smtp',
            smtpSecurity,
            domain,
            dailyLimit,
            cooldownSeconds
        } = req.body;
        const normalizedEmail = normalizeEmail(email);
        const normalizedProvider = provider === 'purelymail' ? 'purelymail' : 'smtp';
        const selectedSecurity = smtpSecurity || (normalizedProvider === 'purelymail' ? 'ssl_tls' : 'starttls');
        const selectedPort = Number(port) || (selectedSecurity === 'ssl_tls' ? PURELYMAIL_SMTP.sslPort : PURELYMAIL_SMTP.startTlsPort);
        const selectedHost = normalizedProvider === 'purelymail' ? PURELYMAIL_SMTP.host : host;

        const account = new EmailAccount({
            label,
            email: normalizedEmail,
            type: 'smtp',
            provider: normalizedProvider,
            domain: domain || getEmailDomain(normalizedEmail),
            smtpSecurity: selectedSecurity,
            credentials: {
                host: selectedHost,
                port: selectedPort,
                user: user || normalizedEmail,
                pass,
                security: selectedSecurity
            },
            dailyLimit: dailyLimit ? Number(dailyLimit) : undefined,
            cooldownSeconds: cooldownSeconds ? Number(cooldownSeconds) : undefined
        });
        const saved = await account.save();
        res.status(201).json(sanitizeAccount(saved));
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
            account.provider = 'gmail';
            account.isActive = true;
            await account.save();
        } else {
            account = new EmailAccount({
                label: userEmail,
                email: userEmail,
                type: 'gmail',
                provider: 'gmail',
                credentials: {
                    accessToken: tokens.access_token,
                    refreshToken: tokens.refresh_token,
                    clientId: GOOGLE_CLIENT_ID,
                    clientSecret: GOOGLE_CLIENT_SECRET
                }
            });
            await account.save();
        }
        res.send(`<!DOCTYPE html><html><head><title>Gmail Connected</title></head><body style="font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;background:#f0fdf4;"><div style="text-align:center"><div style="font-size:48px">✅</div><h2 style="color:#16a34a">Gmail Connected!</h2><p style="color:#6b7280">This window will close automatically...</p></div><script>setTimeout(()=>window.close(),1500);<\/script></body></html>`);
    } catch (err) {
        console.error('OAuth callback error:', err.message);
        res.send(`<!DOCTYPE html><html><head><title>OAuth Failed</title></head><body style="font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;background:#fef2f2;"><div style="text-align:center"><div style="font-size:48px">❌</div><h2 style="color:#dc2626">OAuth Failed</h2><p style="color:#6b7280">Check credentials or try again.</p></div><script>setTimeout(()=>window.close(),2500);<\/script></body></html>`);
    }
});

// ====================== EMAIL SENDING ======================

// RFC 2822 email → base64url (Gmail API format)
const buildRawEmail = ({ fromName, fromEmail, to, subject, html }) => {
    const boundary = `boundary_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    const encodedSubject = `=?UTF-8?B?${Buffer.from(subject, 'utf-8').toString('base64')}?=`;
    const htmlB64 = Buffer.from(html, 'utf-8').toString('base64');
    const textB64 = Buffer.from(html.replace(/<[^>]*>/g, ''), 'utf-8').toString('base64');

    const raw = [
        `From: "${fromName}" <${fromEmail}>`,
        `To: ${to}`,
        `Subject: ${encodedSubject}`,
        'MIME-Version: 1.0',
        `Content-Type: multipart/alternative; boundary="${boundary}"`,
        '',
        `--${boundary}`,
        'Content-Type: text/plain; charset=UTF-8',
        'Content-Transfer-Encoding: base64',
        '',
        textB64,
        '',
        `--${boundary}`,
        'Content-Type: text/html; charset=UTF-8',
        'Content-Transfer-Encoding: base64',
        '',
        htmlB64,
        '',
        `--${boundary}--`
    ].join('\r\n');

    return Buffer.from(raw, 'utf-8')
        .toString('base64')
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/, '');
};

// Gmail account → Gmail API দিয়ে send (HTTPS 443, SMTP port নয়)
const sendViaGmailAPI = async (account, { to, subject, html }) => {
    const oauth2Client = new google.auth.OAuth2(
        account.credentials.clientId || GOOGLE_CLIENT_ID,
        account.credentials.clientSecret || GOOGLE_CLIENT_SECRET,
        GOOGLE_REDIRECT_URI
    );
    oauth2Client.setCredentials({ refresh_token: account.credentials.refreshToken });
    await oauth2Client.refreshAccessToken();

    const gmail = google.gmail({ version: 'v1', auth: oauth2Client });
    const raw = buildRawEmail({ fromName: account.label, fromEmail: account.email, to, subject, html });

    const response = await gmail.users.messages.send({
        userId: 'me',
        requestBody: { raw }
    });

    return { messageId: response.data.id || '', threadId: response.data.threadId || '' };
};

// SMTP account → nodemailer (custom SMTP servers এর জন্য)
const sendViaSmtp = async (account, { to, subject, html }) => {
    const port = Number(account.credentials.port) || 587;
    const security = account.smtpSecurity || account.credentials.security || (port === 465 ? 'ssl_tls' : 'starttls');
    const transporter = nodemailer.createTransport({
        host: account.credentials.host,
        port,
        secure: security === 'ssl_tls' || port === 465,
        requireTLS: security === 'starttls',
        auth: { user: account.credentials.user, pass: account.credentials.pass }
    });
    const info = await transporter.sendMail({
        from: `"${account.label}" <${account.email}>`,
        to,
        subject,
        html
    });
    return { messageId: info.messageId || '', threadId: '' };
};

router.post('/send', async (req, res) => {
    const { templateId, isFollowUp, assignedTo, dryRun } = req.body;
    let preflight;
    try {
        preflight = await runSendPreflight(req.body);
        if (preflight.payload) {
            return res.status(preflight.statusCode || 400).json(preflight.payload);
        }
        if (preflight.error) {
            return res.status(preflight.statusCode || 400).json({
                ok: false,
                dryRun: !!dryRun,
                error: preflight.error
            });
        }

        const {
            account,
            lead,
            toEmail,
            rawSubject,
            rawBody,
            renderedSubject,
            renderedBody,
            checks,
            selection,
            suppression,
            accountReports
        } = preflight;

        if (dryRun) {
            return res.json({
                ok: true,
                dryRun: true,
                canSend: true,
                account: sanitizeAccount(account),
                lead: lead ? normalizeLeadInput(lead.toObject ? lead.toObject() : lead) : null,
                rendered: {
                    subject: renderedSubject,
                    body: renderedBody
                },
                selection,
                suppression,
                accounts: {
                    eligible: accountReports.filter(report => report.eligible).map(report => report.safeAccount),
                    blocked: accountReports.filter(report => !report.eligible).map(report => ({
                        account: report.safeAccount,
                        reasons: report.reasons,
                        checks: report.checks
                    }))
                },
                checks
            });
        }

        const reservedAccount = await reserveSenderSlot(account, checks);
        if (!reservedAccount) {
            const blockedReason = 'Selected sender became unavailable before send because a limit or cooldown changed. Try dry-run again.';
            const blocked = await makeBlockedResponse({
                reqBody: req.body,
                account,
                lead,
                toEmail,
                renderedSubject,
                renderedBody,
                blockedReason,
                statusCode: 409,
                selection,
                suppression,
                accountReports
            });
            return res.status(blocked.statusCode).json(blocked.payload);
        }

        const trackingPixelId = uuidv4();
        const sentAt = new Date();
        const followUpDueAt = new Date(sentAt.getTime() + 3 * 24 * 60 * 60 * 1000);
        const BACKEND_URL = process.env.BACKEND_URL || 'https://agency-backend-geae.onrender.com';
        const unsubUrl = `${BACKEND_URL}/api/mail/unsubscribe/${encodeURIComponent(toEmail)}`;

        const bodyWithPixel = renderedBody
            + `<br><br><hr style="border:none;border-top:1px solid #eee;margin:16px 0"><p style="color:#aaa;font-size:11px;text-align:center;margin:0">Don't want these emails? <a href="${unsubUrl}" style="color:#aaa;text-decoration:underline">Unsubscribe</a></p>`
            + `<img src="${BACKEND_URL}/api/mail/track/${trackingPixelId}" width="1" height="1" style="display:none;" />`;

        // Gmail API বা SMTP দিয়ে পাঠানো
        const info = account.type === 'gmail'
            ? await sendViaGmailAPI(account, { to: toEmail, subject: renderedSubject, html: bodyWithPixel })
            : await sendViaSmtp(account, { to: toEmail, subject: renderedSubject, html: bodyWithPixel });

        // Log সেভ
        const log = new EmailLog({
            from: account.email,
            to: toEmail,
            subject: rawSubject,
            body: rawBody,
            renderedSubject,
            renderedBody,
            status: 'sent',
            sentAt,
            assignedTo: assignedTo || '',
            isFollowUp: !!isFollowUp,
            followUpDueAt,
            trackingPixelId,
            messageId: info.messageId || '',
            threadId: info.threadId || '',
            leadId: lead?._id,
            accountId: account._id,
            provider: resolveAccountProvider(account),
            senderName: account.label,
            senderEmail: account.email
        });
        await log.save();

        // Template usageCount++
        if (templateId) {
            await EmailTemplate.findByIdAndUpdate(templateId, { $inc: { usageCount: 1 } });
        }

        // Lead status আপডেট
        await Lead.findOneAndUpdate(
            { email: toEmail },
            { status: 'contacted', lastContactedAt: sentAt },
            { upsert: false }
        );

        res.json({
            message: 'Email sent successfully!',
            logId: log._id,
            account: sanitizeAccount(reservedAccount),
            selection
        });

    } catch (err) {
        console.error('Send error:', err.message);
        const toEmail = preflight?.toEmail || normalizeEmail(req.body.to);
        const toDomain = preflight?.toDomain || getEmailDomain(toEmail);
        const account = preflight?.account;
        const lead = preflight?.lead;
        const failedStatus = err.responseCode >= 500 ? 'bounced' : 'failed';

        if (!dryRun && toEmail) {
            await new EmailLog({
                from: account?.email || normalizeEmail(req.body.from),
                to: toEmail,
                subject: preflight?.rawSubject || req.body.subject || '',
                body: preflight?.rawBody || req.body.body || '',
                renderedSubject: preflight?.renderedSubject || req.body.subject || '',
                renderedBody: preflight?.renderedBody || req.body.body || '',
                status: failedStatus,
                errorMessage: err.message,
                assignedTo: normalizeEmail(req.body.assignedTo),
                isFollowUp: !!req.body.isFollowUp,
                leadId: lead?._id,
                accountId: account?._id,
                provider: resolveAccountProvider(account),
                senderName: account?.label || '',
                senderEmail: account?.email || '',
                trackingPixelId: uuidv4()
            }).save().catch(() => {});
        }

        if (err.responseCode >= 500 && toEmail) {
            await Blacklist.findOneAndUpdate(
                { email: toEmail },
                { email: toEmail, domain: toDomain, reason: 'bounced' },
                { upsert: true }
            ).catch(() => {});
            await Lead.findOneAndUpdate({ email: toEmail }, { status: 'bounced' }).catch(() => {});
        }
        res.status(500).json({ error: err.message });
    }
});

// ====================== EMAIL BODY EXTRACTOR ======================
// ✅ উন্নত ভার্সন — সব ধরনের nested multipart email structure হ্যান্ডেল করতে পারবে

function extractEmailBody(payload) {
    if (!payload) return '';

    // Direct body (non-multipart email)
    if (payload.body && payload.body.size > 0 && payload.body.data) {
        return Buffer.from(payload.body.data, 'base64').toString('utf-8');
    }

    if (!payload.parts || payload.parts.length === 0) return '';

    let htmlBody = '';
    let textBody = '';

    const searchParts = (parts) => {
        for (const part of parts) {
            if (part.mimeType === 'text/html' && part.body && part.body.data) {
                htmlBody = Buffer.from(part.body.data, 'base64').toString('utf-8');
            }
            if (part.mimeType === 'text/plain' && part.body && part.body.data && !textBody) {
                textBody = Buffer.from(part.body.data, 'base64').toString('utf-8');
            }
            if (part.parts && part.parts.length > 0) {
                searchParts(part.parts);
            }
        }
    };

    searchParts(payload.parts);
    return htmlBody || textBody || '';
}

// ====================== INBOX (REPLIES) ======================
// ✅ OOM Fix: আগে 50টা email এর full body একসাথে RAM এ লোড হতো — এখন শুধু headers নেওয়া হচ্ছে
// Body আলাদাভাবে lazy-load হবে যখন ইউজার ক্লিক করবে

router.get('/inbox/:salesmanEmail', async (req, res) => {
    try {
        const { salesmanEmail } = req.params;

        // ✅ Role-Based Access Check — Sidebar এর মতো একই রুল backend এও enforce করা
        // Blocked: Editor only, Editor + Admin (Marketer ছাড়া)
        // Allowed: Marketer, Admin only (Editor ছাড়া), Admin + Editor + Marketer
        const callerUser = await User.findOne({ email: salesmanEmail });
        if (callerUser) {
            const callerRoles = Array.isArray(callerUser.role) ? callerUser.role : [callerUser.role];
            const hasMarketer = callerRoles.includes('Marketer');
            const hasEditor = callerRoles.includes('Editor');
            const hasAdmin = callerRoles.includes('Admin');

            // Editor+Admin কিন্তু Marketer নেই → Gmail poll করবে না, সরাসরি খালি রিটার্ন
            if (hasEditor && !hasMarketer) {
                return res.json({ gmailReplies: [], smtpReplies: [] });
            }
        }

        const target = await SalesTarget.findOne({ salesmanEmail }).populate('assignedAccounts');

        // SalesTarget না থাকলে, User এর role চেক করো
        // Admin হলে সব accounts, অন্যথা খালি (strict isolation)
        let accountsToCheck;
        if (target) {
            accountsToCheck = target.assignedAccounts;
        } else {
            const callerRoles = callerUser ? (Array.isArray(callerUser.role) ? callerUser.role : [callerUser.role]) : [];
            const isAdmin = callerRoles.includes('Admin');
            accountsToCheck = isAdmin ? await EmailAccount.find({ type: 'gmail', isActive: true }) : [];
        }

        const allReplies = [];

        for (const account of accountsToCheck) {
            if (account.type !== 'gmail' || !account.credentials.refreshToken) continue;
            try {
                const oauth2Client = new google.auth.OAuth2(
                    account.credentials.clientId || GOOGLE_CLIENT_ID,
                    account.credentials.clientSecret || GOOGLE_CLIENT_SECRET,
                    GOOGLE_REDIRECT_URI
                );
                oauth2Client.setCredentials({
                    refresh_token: account.credentials.refreshToken
                });
                // Token সবসময় refresh করা
                await oauth2Client.refreshAccessToken();

                const gmail = google.gmail({ version: 'v1', auth: oauth2Client });
                const listRes = await gmail.users.messages.list({
                    userId: 'me',
                    labelIds: ['INBOX'],
                    maxResults: 15  // ✅ OOM Fix: 50 → 15 (RAM কম খাবে, rate limit ও কমবে)
                });

                const messages = listRes.data.messages || [];

                // ✅ OOM Fix: format 'full' → 'metadata' (শুধু headers, body নয়)
                // Body পরে lazy-load হবে /message-body/ endpoint দিয়ে
                for (const msg of messages) {
                    const detail = await gmail.users.messages.get({
                        userId: 'me',
                        id: msg.id,
                        format: 'metadata',
                        metadataHeaders: ['From', 'Subject', 'Date']
                    });
                    const headers = detail.data.payload?.headers || [];
                    const getHeader = (name) => (headers.find(h => h.name.toLowerCase() === name.toLowerCase()) || {}).value || '';

                    const threadId = detail.data.threadId;

                    allReplies.push({
                        messageId: msg.id,
                        threadId,
                        from: getHeader('From'),
                        subject: getHeader('Subject'),
                        date: getHeader('Date'),
                        body: '',  // ✅ body খালি — ক্লিক করলে lazy-load হবে
                        account: account.email,
                        logUpdated: false
                    });
                }

                // ✅ OOM Fix: EmailLog bulk update (আগে 1 by 1 ছিল)
                const threadIds = allReplies.filter(r => r.account === account.email).map(r => r.threadId).filter(Boolean);
                if (threadIds.length > 0) {
                    await EmailLog.updateMany(
                        { threadId: { $in: threadIds }, replied: false },
                        { replied: true, repliedAt: new Date(), status: 'replied' }
                    );
                }

            } catch (gmailErr) {
                console.error(`Gmail poll error for ${account.email}:`, gmailErr.message);
            }
        }

        // SMTP replied logs
        const smtpReplies = await EmailLog.find({
            from: { $in: accountsToCheck.map(a => a.email) },
            replied: true
        }).sort({ repliedAt: -1 }).limit(15);

        res.json({ gmailReplies: allReplies, smtpReplies });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ✅ নতুন API: email body lazy-load — ক্লিক করলে শুধু সেই একটা email এর body আনবে
router.get('/message-body/:accountEmail/:messageId', async (req, res) => {
    try {
        const { accountEmail, messageId } = req.params;
        const account = await EmailAccount.findOne({ email: accountEmail, isActive: true });
        if (!account || account.type !== 'gmail') {
            return res.status(404).json({ error: 'Account not found' });
        }

        const oauth2Client = new google.auth.OAuth2(
            account.credentials.clientId || GOOGLE_CLIENT_ID,
            account.credentials.clientSecret || GOOGLE_CLIENT_SECRET,
            GOOGLE_REDIRECT_URI
        );
        oauth2Client.setCredentials({ refresh_token: account.credentials.refreshToken });
        await oauth2Client.refreshAccessToken();

        const gmail = google.gmail({ version: 'v1', auth: oauth2Client });
        const detail = await gmail.users.messages.get({ userId: 'me', id: messageId, format: 'full' });
        const body = extractEmailBody(detail.data.payload);

        res.json({ body });
    } catch (err) {
        console.error('Message body fetch error:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// ====================== OPEN TRACKING ======================

router.get('/track/:pixelId', async (req, res) => {
    try {
        await EmailLog.findOneAndUpdate(
            { trackingPixelId: req.params.pixelId, opened: false, status: { $nin: ['replied', 'bounced', 'failed', 'blocked'] } },
            { opened: true, openedAt: new Date(), status: 'opened' }
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
        const logs = await EmailLog.find(sentCountFilter({
            assignedTo: req.params.salesmanEmail,
            replied: false,
            followUpDueAt: { $lte: now }
        })).sort({ followUpDueAt: 1 });
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
        const lead = new Lead(normalizeLeadInput(req.body));
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
                const normalizedLead = normalizeLeadInput(lead);
                await Lead.findOneAndUpdate(
                    { email: normalizedLead.email },
                    normalizedLead,
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
        const updated = await Lead.findByIdAndUpdate(req.params.id, normalizeLeadInput(req.body), { new: true });
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
        res.json(targets.map(sanitizeTarget));
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
            EmailLog.countDocuments(sentCountFilter({ assignedTo: salesmanEmail, sentAt: { $gte: today, $lt: tomorrow } })),
            EmailLog.countDocuments({ assignedTo: salesmanEmail, replied: true, repliedAt: { $gte: today, $lt: tomorrow } }),
            EmailLog.countDocuments(sentCountFilter({ assignedTo: salesmanEmail, replied: false, followUpDueAt: { $lte: new Date() } }))
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
                EmailLog.countDocuments(sentCountFilter({ assignedTo: t.salesmanEmail, sentAt: { $gte: today, $lt: tomorrow } })),
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
                assignedAccounts: sanitizeAccounts(t.assignedAccounts || [])
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

// ====================== SENT EMAIL LOGS ======================

router.get('/logs', async (req, res) => {
    try {
        const { assignedTo, page = 1, limit = 100 } = req.query;
        const filter = assignedTo ? { assignedTo } : {};
        const logs = await EmailLog.find(filter)
            .sort({ sentAt: -1 })
            .skip((Number(page) - 1) * Number(limit))
            .limit(Number(limit));
        const total = await EmailLog.countDocuments(filter);
        res.json({ logs, total });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ====================== SINGLE LOG STATUS ======================

router.get('/logs/:id', async (req, res) => {
    try {
        const log = await EmailLog.findById(req.params.id).select('messageId status opened openedAt sentAt errorMessage blockedReason');
        if (!log) return res.status(404).json({ error: 'Log not found' });
        res.json(log);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ====================== EMAIL UNSUBSCRIBE ======================

router.get('/unsubscribe/:email', async (req, res) => {
    try {
        const email = decodeURIComponent(req.params.email);
        await Lead.findOneAndUpdate({ email }, { status: 'unsubscribed' });
        await Blacklist.findOneAndUpdate(
            { email },
            { email, domain: email.split('@')[1] || '', reason: 'unsubscribed' },
            { upsert: true }
        );
        res.send(`<!DOCTYPE html><html><head><title>Unsubscribed</title></head><body style="font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;background:#f9fafb"><div style="text-align:center"><div style="font-size:48px">✉️</div><h2 style="color:#374151">You have been unsubscribed</h2><p style="color:#6b7280">You will no longer receive emails from us.</p></div></body></html>`);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ====================== LEAD NOTES & STATUS UPDATE ======================

router.patch('/leads/:id', async (req, res) => {
    try {
        const update = {};
        const leadFields = ['firstName', 'lastName', 'name', 'email', 'company', 'website', 'domain', 'youtubeChannel', 'niche'];
        for (const field of leadFields) {
            if (req.body[field] !== undefined) update[field] = req.body[field];
        }
        if (req.body.note !== undefined) {
            update.note = req.body.note;
            if (req.body.notes === undefined) update.notes = req.body.note;
        }
        if (req.body.notes !== undefined) update.notes = req.body.notes;
        if (req.body.status !== undefined) update.status = req.body.status;
        const lead = await Lead.findByIdAndUpdate(req.params.id, normalizeLeadInput(update), { new: true });
        res.json(lead);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

module.exports = router;
