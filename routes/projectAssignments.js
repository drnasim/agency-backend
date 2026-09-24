const express = require('express');
const mongoose = require('mongoose');
const Client = require('../models/Client');
const Project = require('../models/Project');
const MobileDevice = require('../models/MobileDevice');
const { authenticate } = require('../middleware/authenticate');
const {
    acceptProjectAssignment,
    acknowledgeProjectAssignmentDelivery,
    buildActiveProjectFilter,
    buildProjectAcceptanceResponse,
    filterActiveProjectsForUser,
    formatAssignmentForClient,
    getProjectUrl,
    hasRole,
    parseAssignmentVersion,
    serializeProjectForApi
} = require('../services/projectAssignments');
const { publishProjectAssignmentEvent } = require('../services/projectAssignmentEvents');
const { buildClientGuidelineData } = require('../utils/clientGuidelines');

const { getEditorWorkspaceEvents } = require('../services/editorWorkspaceEvents');

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

const toLeanValue = async query => (
    query && typeof query.lean === 'function' ? query.lean() : query
);

const createProjectDetailsHandler = ({
    ProjectModel = Project,
    ClientModel = Client,
    buildProjectFilter = buildActiveProjectFilter,
    filterProjects = filterActiveProjectsForUser,
    formatGuidelines = buildClientGuidelineData,
    isValidProjectId = mongoose.isValidObjectId,
    getNow = () => new Date(),
    logger = console
} = {}) => async (req, res) => {
    const projectId = String(req.params?.projectId || '').trim();
    const unavailable = () => res.status(404).json({ error: 'Project is unavailable' });

    if (!projectId || !isValidProjectId(projectId)) return unavailable();

    try {
        const project = await toLeanValue(ProjectModel.findOne({
            _id: projectId,
            ...buildProjectFilter(req.user)
        }));
        if (!project) return unavailable();

        // The database filter keeps the common immutable-ID path narrow. The
        // second verification is required for legacy records whose editor is
        // stored only as a display-name/email reference.
        const [visibleProject] = await filterProjects([project], req.user);
        if (!visibleProject) return unavailable();

        const clientName = String(visibleProject.client || '').trim();
        const client = clientName
            ? await toLeanValue(ClientModel.findOne(
                { name: clientName },
                {
                    guidelines: 1,
                    guidelineItems: 1,
                    guidelineNotes: 1,
                    _id: 0
                }
            ))
            : null;
        const guidelineData = formatGuidelines(client);

        return res.json({
            serverTime: getNow().toISOString(),
            project: {
                ...serializeProjectForApi(visibleProject),
                projectUrl: getProjectUrl(visibleProject),
                clientGuidelines: guidelineData.clientGuidelines,
                clientGuidelineProfile: guidelineData.clientGuidelineProfile
            }
        });
    } catch (error) {
        logger.error('Editor project detail sync failed:', error.message);
        return res.status(500).json({ error: 'Project details are unavailable' });
    }
};

router.use(authenticate, requireEditor);

router.get('/updates', async (req, res) => {
    try { return res.json({ updates: await getEditorWorkspaceEvents(req.user._id) }); }
    catch { return res.status(500).json({ error: 'Project updates are unavailable' }); }
});

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

router.get('/active', async (req, res) => {
    try {
        const now = new Date();
        const candidates = await Project.find(buildActiveProjectFilter(req.user))
            .sort({ deadline: 1, updatedAt: -1 })
            .lean();
        const projects = await filterActiveProjectsForUser(candidates, req.user);

        return res.json({
            serverTime: now.toISOString(),
            projects: projects.map(project => ({
                ...serializeProjectForApi(project),
                projectUrl: getProjectUrl(project)
            }))
        });
    } catch (error) {
        console.error('Active editor project sync failed:', error.message);
        return res.status(500).json({ error: 'Active editor projects are unavailable' });
    }
});

router.get('/:projectId/details', createProjectDetailsHandler());

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

        return res.json(buildProjectAcceptanceResponse({
            project,
            requestId,
            assignmentVersion,
            alreadyAccepted
        }));
    } catch (error) {
        console.error('Project assignment acceptance failed:', error.message);
        return res.status(error.statusCode || 500).json({
            error: error.statusCode ? error.message : 'The project assignment could not be accepted',
            ...(error.code ? { code: error.code } : {})
        });
    }
});

module.exports = router;
module.exports.createProjectDetailsHandler = createProjectDetailsHandler;
module.exports.requireEditor = requireEditor;
