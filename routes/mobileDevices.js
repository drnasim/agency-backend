const express = require('express');
const MobileDevice = require('../models/MobileDevice');
const { authenticate } = require('../middleware/authenticate');

const router = express.Router();

const cleanText = (value, maxLength) => String(value || '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLength);

const isValidInstallationId = value => (
    typeof value === 'string' &&
    value.length >= 8 &&
    value.length <= 200 &&
    /^[A-Za-z0-9._:-]+$/.test(value)
);

const isValidFcmToken = value => (
    typeof value === 'string' && value.trim().length >= 20 && value.trim().length <= 4096
);

const formatDevice = device => ({
    installationId: String(device.installationId),
    platform: device.platform || 'android',
    enabled: device.enabled !== false,
    lastSeenAt: device.lastSeenAt,
    deviceLabel: device.deviceLabel || '',
    appVersion: device.appVersion || ''
});

router.use(authenticate);

router.put('/:installationId', async (req, res) => {
    try {
        const installationId = String(req.params.installationId || '').trim();
        const fcmToken = String(req.body?.fcmToken || '').trim();
        if (!isValidInstallationId(installationId)) {
            return res.status(400).json({ error: 'A valid installation ID is required' });
        }
        if (!isValidFcmToken(fcmToken)) {
            return res.status(400).json({ error: 'A valid FCM token is required' });
        }
        if (req.body?.platform && req.body.platform !== 'android') {
            return res.status(400).json({ error: 'Only Android mobile devices are supported' });
        }

        const now = new Date();
        const update = {
            userId: req.user._id,
            installationId,
            fcmToken,
            platform: 'android',
            enabled: true,
            lastSeenAt: now,
            deviceLabel: cleanText(req.body?.deviceLabel, 120),
            appVersion: cleanText(req.body?.appVersion, 50)
        };

        let device;
        try {
            // An FCM registration token represents one app installation. If
            // Android restored/rotated identifiers, retire the stale row before
            // binding the provider token to this authenticated installation.
            await MobileDevice.deleteMany({
                fcmToken,
                installationId: { $ne: installationId }
            });
            device = await MobileDevice.findOneAndUpdate(
                { installationId },
                { $set: update, $setOnInsert: { createdAt: now } },
                { new: true, upsert: true, runValidators: true, setDefaultsOnInsert: true }
            );
        } catch (error) {
            // Resolve a concurrent registration race without ever accepting a
            // caller-supplied user ID.
            if (error?.code !== 11000) throw error;
            await MobileDevice.deleteMany({
                fcmToken,
                installationId: { $ne: installationId }
            });
            device = await MobileDevice.findOneAndUpdate(
                { installationId },
                { $set: update },
                { new: true, upsert: true, runValidators: true, setDefaultsOnInsert: true }
            );
            if (!device) throw error;
        }

        return res.status(200).json({ device: formatDevice(device) });
    } catch (error) {
        console.error('Mobile device registration failed:', error.message);
        return res.status(500).json({ error: 'The mobile device could not be registered' });
    }
});

router.delete('/:installationId', async (req, res) => {
    try {
        const installationId = String(req.params.installationId || '').trim();
        if (!isValidInstallationId(installationId)) {
            return res.status(400).json({ error: 'A valid installation ID is required' });
        }
        const result = await MobileDevice.deleteOne({
            installationId,
            userId: req.user._id
        });
        return res.json({ removed: result.deletedCount > 0 });
    } catch (error) {
        console.error('Mobile device removal failed:', error.message);
        return res.status(500).json({ error: 'The mobile device could not be removed' });
    }
});

module.exports = router;
module.exports.cleanText = cleanText;
module.exports.formatDevice = formatDevice;
module.exports.isValidFcmToken = isValidFcmToken;
module.exports.isValidInstallationId = isValidInstallationId;
