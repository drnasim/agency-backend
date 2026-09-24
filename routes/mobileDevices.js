const express = require('express');
const Project = require('../models/Project');
const MobileDevice = require('../models/MobileDevice');
const { authenticate } = require('../middleware/authenticate');
const {
    acceptProjectAssignment,
    buildProjectAcceptanceResponse,
    hasRole,
    parseAssignmentVersion
} = require('../services/projectAssignments');
const { publishProjectAssignmentEvent } = require('../services/projectAssignmentEvents');

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

const requireEditor = (req, res, next) => {
    if (!hasRole(req.user, 'Editor')) {
        return res.status(403).json({ error: 'Editor access is required' });
    }
    return next();
};

const createAcceptProjectHandler = ({
    ProjectModel = Project,
    MobileDeviceModel = MobileDevice,
    acceptAssignment = acceptProjectAssignment,
    publishEvent = publishProjectAssignmentEvent,
    getNow = () => new Date(),
    logger = console
} = {}) => async (req, res) => {
    try {
        const requestId = String(req.body?.assignmentRequestId || '').trim();
        const assignmentVersion = parseAssignmentVersion(req.body?.assignmentVersion);
        const suppliedInstallationId = req.body?.installationId;
        const installationId = typeof suppliedInstallationId === 'string'
            ? suppliedInstallationId.trim()
            : '';

        if (!requestId || requestId.length > 100) {
            return res.status(400).json({ error: 'Assignment request ID is required' });
        }
        if (!assignmentVersion) {
            return res.status(400).json({ error: 'A valid assignment version is required' });
        }
        if (suppliedInstallationId !== undefined && !isValidInstallationId(installationId)) {
            return res.status(400).json({ error: 'A valid installation ID is required' });
        }

        if (installationId) {
            const registeredDevice = await MobileDeviceModel.exists({
                userId: req.user._id,
                installationId,
                enabled: true
            });
            if (!registeredDevice) {
                return res.status(403).json({
                    error: 'This installation is not registered to the current editor'
                });
            }
        }

        const now = getNow();
        const { project, alreadyAccepted } = await acceptAssignment({
            ProjectModel,
            requestId,
            assignmentVersion,
            user: req.user,
            now
        });

        if (installationId) {
            try {
                await MobileDeviceModel.updateOne(
                    { userId: req.user._id, installationId },
                    { $set: { lastSeenAt: now } }
                );
            } catch (error) {
                // The assignment mutation is already authoritative. A device
                // heartbeat failure must not turn an accepted offline-queue
                // retry into an apparent project failure.
                logger.error('Accepted project device heartbeat failed:', error.message);
            }
        }

        if (!alreadyAccepted) {
            try {
                await publishEvent({
                    project,
                    action: 'accepted',
                    recipientUserIds: [req.user._id],
                    includeAdmins: true,
                    sendMobile: true
                });
            } catch (error) {
                // REST acceptance is the source of truth; realtime and push
                // updates are supplemental after the compare-and-set commits.
                logger.error('Project acceptance event delivery failed:', error.message);
            }
        }

        return res.json(buildProjectAcceptanceResponse({
            project,
            requestId,
            assignmentVersion,
            alreadyAccepted
        }));
    } catch (error) {
        logger.error('Mobile project acceptance failed:', error.message);
        return res.status(error.statusCode || 500).json({
            error: error.statusCode ? error.message : 'The project assignment could not be accepted',
            ...(error.code ? { code: error.code } : {})
        });
    }
};

router.use(authenticate);

// Canonical, queue-safe mobile acceptance endpoint. The immutable request ID
// and assignment version make repeated POSTs safe after ambiguous/offline
// retries; Socket.IO is never involved in committing the acceptance.
router.post('/accept-project', requireEditor, createAcceptProjectHandler());

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
module.exports.createAcceptProjectHandler = createAcceptProjectHandler;
module.exports.requireEditor = requireEditor;
