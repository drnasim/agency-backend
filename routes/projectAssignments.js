const express = require('express');
const Project = require('../models/Project');
const MobileDevice = require('../models/MobileDevice');
const { authenticate } = require('../middleware/authenticate');
const {
    acceptProjectAssignment,
    acknowledgeProjectAssignmentDelivery,
    formatAssignmentForClient,
    getProjectUrl,
    hasRole,
    parseAssignmentVersion,
    serializeProjectForApi
} = require('../services/projectAssignments');
const { publishProjectAssignmentEvent } = require('../services/projectAssignmentEvents');

const router = express.Router();

const requireEditor = (req, res, next) => {
    if (!hasRole(req.user, 'Editor')) {
        return res.status(403).json({ error: 'Editor access is required' });
    }
    return next();
};

const publishSafely = async options => {
    try {
        return await publishProjectAssignmentEvent(options);
    } catch (error) {
        // The lifecycle write has already committed. Record a delivery failure
        // without making an editor retry a successful acceptance.
        console.error('Project assignment event delivery failed:', error.message);
        return null;
    }
};

router.use(authenticate, requireEditor);

router.get('/pending', async (req, res) => {
    try {
        const now = new Date();
        const projects = await Project.find({
            assignedEditorUserId: req.user._id,
            assignmentStatus: 'pending'
        }).sort({ assignedAt: 1 }).lean();

        return res.json({
            serverTime: now.toISOString(),
            assignments: projects.map(formatAssignmentForClient)
        });
    } catch (error) {
        console.error('Pending project assignment sync failed:', error.message);
        return res.status(500).json({ error: 'Pending project assignments are unavailable' });
    }
});

router.post('/:requestId/delivered', async (req, res) => {
    try {
        const requestId = String(req.params.requestId || '').trim();
        const installationId = String(req.body?.installationId || '').trim();
        if (!requestId) return res.status(400).json({ error: 'Assignment request ID is required' });
        if (!installationId) return res.status(400).json({ error: 'Installation ID is required' });

        const registeredDevice = await MobileDevice.exists({
            userId: req.user._id,
            installationId,
            enabled: true
        });
        if (!registeredDevice) {
            return res.status(403).json({ error: 'This installation is not registered to the current editor' });
        }

        const now = new Date();
        const { project, newlyDelivered } = await acknowledgeProjectAssignmentDelivery({
            ProjectModel: Project,
            requestId,
            userId: req.user._id,
            now
        });

        await MobileDevice.updateOne(
            { userId: req.user._id, installationId },
            { $set: { lastSeenAt: now } }
        );

        if (newlyDelivered) {
            await publishSafely({
                project,
                action: 'delivered',
                recipientUserIds: [req.user._id],
                includeAdmins: true,
                sendMobile: false
            });
        }

        return res.json({
            assignmentRequestId: requestId,
            assignmentVersion: Number(project.assignmentVersion) || 0,
            assignmentStatus: project.assignmentStatus,
            deliveredAt: project.deliveredAt
        });
    } catch (error) {
        console.error('Project assignment delivery acknowledgement failed:', error.message);
        return res.status(error.statusCode || 500).json({
            error: error.statusCode ? error.message : 'The project assignment delivery could not be recorded',
            ...(error.code ? { code: error.code } : {})
        });
    }
});

router.post('/:requestId/accept', async (req, res) => {
    try {
        const requestId = String(req.params.requestId || '').trim();
        const assignmentVersion = parseAssignmentVersion(req.body?.assignmentVersion);
        if (!requestId) return res.status(400).json({ error: 'Assignment request ID is required' });
        if (!assignmentVersion) {
            return res.status(400).json({ error: 'A valid assignment version is required' });
        }

        const { project, alreadyAccepted } = await acceptProjectAssignment({
            ProjectModel: Project,
            requestId,
            assignmentVersion,
            user: req.user,
            now: new Date()
        });

        if (!alreadyAccepted) {
            await publishSafely({
                project,
                action: 'accepted',
                recipientUserIds: [req.user._id],
                includeAdmins: true,
                sendMobile: true
            });
        }

        return res.json({
            assignmentStatus: 'accepted',
            assignmentRequestId: requestId,
            assignmentVersion,
            acceptedAt: project.acceptedAt,
            acceptedBy: {
                userId: String(project.acceptedBy?.userId || ''),
                name: String(project.acceptedBy?.name || '')
            },
            project: serializeProjectForApi(project),
            projectUrl: getProjectUrl(project),
            alreadyAccepted
        });
    } catch (error) {
        console.error('Project assignment acceptance failed:', error.message);
        return res.status(error.statusCode || 500).json({
            error: error.statusCode ? error.message : 'The project assignment could not be accepted',
            ...(error.code ? { code: error.code } : {})
        });
    }
});

module.exports = router;
module.exports.requireEditor = requireEditor;
