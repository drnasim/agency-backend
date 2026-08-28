const express = require('express');
const router = express.Router();
const Project = require('../models/Project');
const Client = require('../models/Client');
const { alarmUsers } = require('../fcm');
const { resolveNotificationRecipient } = require('../utils/notificationRecipients');
const { authenticate, requireAdmin } = require('../middleware/authenticate');
const { deliverNotificationToReferences } = require('../services/notificationDelivery');
const { resolveUsersForReferences } = require('../services/pushRecipients');
const {
    buildClearedAssignmentFields,
    buildPendingAssignmentFields,
    isTerminalProjectStatus,
    isUnassignedReference,
    normalizeEditorReference,
    resolveAssignedEditorUser,
    resolveProjectAssignedUser,
    serializeProjectForApi,
    stripProjectAssignmentLifecycleFields
} = require('../services/projectAssignments');
const { publishProjectAssignmentEvent } = require('../services/projectAssignmentEvents');
const { buildClientGuidelineData } = require('../utils/clientGuidelines');

const REVIEW_STATUSES = new Set(['Submitted', 'Under Review']);

const hasOwn = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);

const parseRequiredDate = (value, label) => {
    const date = new Date(value);
    if (!value || Number.isNaN(date.getTime())) {
        const err = new Error(`Invalid ${label}`);
        err.statusCode = 400;
        throw err;
    }
    return date;
};

const buildProjectUpdate = (body, oldProject) => {
    const update = stripProjectAssignmentLifecycleFields(body);

    // Creator identity is assigned from the authenticated session at creation and
    // cannot be redirected by a later assignment/submission request.
    delete update.createdByUserId;
    delete update.createdBy;
    delete update.createdByEmail;
    delete update._id;
    delete update.__v;

    if (hasOwn(update, 'createdAt')) {
        update.createdAt = parseRequiredDate(update.createdAt, 'project creation date');
    }

    if (update.status === 'Completed' && oldProject?.status !== 'Completed' && !update.completedAt) {
        update.completedAt = new Date();
    }

    if (
        oldProject?.status === 'Completed' &&
        !oldProject.completedAt &&
        !update.completedAt
    ) {
        update.completedAt = oldProject.completedDate || oldProject.createdAt || new Date();
    }

    return update;
};

const getProjectUpdateFilter = (projectId, oldProject, assignmentTransition = false) => {
    if (!assignmentTransition) return { _id: projectId };
    const currentVersion = Math.max(0, Number(oldProject?.assignmentVersion) || 0);
    return currentVersion === 0
        ? {
            _id: projectId,
            $or: [
                { assignmentVersion: 0 },
                { assignmentVersion: { $exists: false } }
            ]
        }
        : { _id: projectId, assignmentVersion: currentVersion };
};

const updateProjectById = async (projectId, update, oldProject, { assignmentTransition = false } = {}) => {
    const filter = getProjectUpdateFilter(projectId, oldProject, assignmentTransition);
    if (!hasOwn(update, 'createdAt')) {
        return Project.findOneAndUpdate(
            filter,
            { $set: update },
            { new: true, runValidators: true }
        );
    }

    if (!oldProject) return null;

    const { createdAt, ...schemaUpdate } = update;
    if (Object.keys(schemaUpdate).length > 0) {
        const schemaUpdatedProject = await Project.findOneAndUpdate(
            filter,
            { $set: schemaUpdate },
            { new: true, runValidators: true }
        );

        if (!schemaUpdatedProject) return null;
    }

    const rawUpdate = await Project.collection.updateOne(
        { _id: oldProject._id },
        { $set: { createdAt, updatedAt: new Date() } }
    );

    if (!rawUpdate.matchedCount) return null;

    return Project.findById(projectId);
};

const getAssignedEditor = (project) => {
    const editor = project.assignedEditor || project.editor || project.assignedTo || '';
    return String(editor).trim();
};

const getRequestedEditor = (oldProject, update) => {
    if (hasOwn(update, 'assignedEditor')) return String(update.assignedEditor || '').trim();
    if (hasOwn(update, 'editor')) return String(update.editor || '').trim();
    if (hasOwn(update, 'assignedTo')) return String(update.assignedTo || '').trim();
    return getAssignedEditor(oldProject);
};

const prepareProjectAssignmentTransition = async (oldProject, update, now = new Date()) => {
    const oldEditor = getAssignedEditor(oldProject);
    const newEditor = getRequestedEditor(oldProject, update);
    const editorChanged = normalizeEditorReference(oldEditor) !== normalizeEditorReference(newEditor);
    const nextStatus = hasOwn(update, 'status') ? update.status : oldProject?.status;
    const terminalProject = isTerminalProjectStatus(nextStatus);
    const terminalCancellation = oldProject?.assignmentStatus === 'pending' && terminalProject;

    if (editorChanged) {
        update.assignedEditor = newEditor;
        update.editor = newEditor;
    }

    if (!editorChanged && !terminalCancellation) {
        return { changed: false, oldEditor, newEditor };
    }

    // Preserve already-accepted history on a terminal project while allowing
    // Admins to correct its legacy display fields. There is no live request to
    // cancel and no new request may be created.
    if (terminalProject && !terminalCancellation) {
        return { changed: false, oldEditor, newEditor, terminal: true };
    }

    const oldRecipientUser = oldProject?.assignmentStatus === 'pending'
        ? await resolveProjectAssignedUser(oldProject)
        : null;

    // A terminal project must never create a fresh assignment request merely
    // because its historical editor field was corrected or changed.
    if (terminalProject || isUnassignedReference(newEditor)) {
        Object.assign(update, buildClearedAssignmentFields(oldProject));
        return {
            changed: true,
            kind: 'cancelled',
            reason: terminalProject ? 'project_terminal' : 'unassigned',
            oldEditor,
            newEditor,
            oldRecipientUser,
            newRecipientUser: null
        };
    }

    const newRecipientUser = await resolveAssignedEditorUser(newEditor);
    // Keep both legacy editor fields aligned so future authorization, filtering
    // and lifecycle transitions cannot disagree about the current assignee.
    Object.assign(update, buildPendingAssignmentFields({
        project: oldProject,
        assignedEditorUser: newRecipientUser,
        now
    }));
    return {
        changed: true,
        kind: oldEditor ? 'reassigned' : 'assigned',
        reason: oldEditor ? 'reassigned' : 'assigned',
        oldEditor,
        newEditor,
        oldRecipientUser,
        newRecipientUser
    };
};

const buildAssignmentTransitionDeliveries = ({ oldProject, updatedProject, transition }) => {
    if (!transition?.changed) return [];
    const deliveries = [];
    if (transition.oldRecipientUser) {
        deliveries.push({
            project: oldProject,
            action: transition.reason === 'reassigned' ? 'reassigned' : 'cancelled',
            reason: transition.reason,
            recipientUserIds: [transition.oldRecipientUser._id]
        });
    }
    if (transition.newRecipientUser) {
        deliveries.push({
            project: updatedProject,
            // `assigned` is the only start action understood by Android;
            // `reassigned` is reserved as a stop for the old request above.
            action: 'assigned',
            reason: transition.reason,
            recipientUserIds: [transition.newRecipientUser._id]
        });
    }
    return deliveries;
};

const publishAssignmentTransition = async ({ oldProject, updatedProject, transition }) => {
    const deliveries = buildAssignmentTransitionDeliveries({ oldProject, updatedProject, transition });
    for (const delivery of deliveries) {
        await publishProjectAssignmentEvent({
            ...delivery,
            includeAdmins: true,
            sendMobile: true
        });
    }

    if (transition?.newRecipientUser) {

        const copy = buildProjectAssignmentCopy(updatedProject);
        await notifyProjectRecipient(
            transition.newEditor,
            copy.title,
            copy.body,
            updatedProject,
            'new_project',
            { sendFcm: false }
        );
    }
};

const publishAssignmentTransitionSafely = async options => {
    try {
        return await publishAssignmentTransition(options);
    } catch (error) {
        // Project persistence is authoritative. Await the delivery attempt to
        // avoid a process-exit race, but do not invite duplicate mutations by
        // failing an already-committed request when a provider is unavailable.
        console.error('Project assignment transition delivery failed:', error.message);
        return null;
    }
};

const formatProjectForApi = project => {
    const value = serializeProjectForApi(project);
    if (!value) return value;
    return {
        ...value,
        editor: value.editor || value.assignedTo || value.assignedEditor || 'Unassigned'
    };
};

const uniqueIdentityList = (items = []) => (
    [...new Set(items.map(item => String(item || '').trim()).filter(Boolean))]
);

const getProjectNotificationUrl = (project) => (
    project?._id ? `/project/${project._id.toString()}` : '/projects'
);

const buildProjectAssignmentCopy = (project) => {
    const projectName = project.title || project.projectName || 'A new project';
    const clientSuffix = project.client ? ` for ${project.client}` : '';
    return {
        title: 'New Project Assigned',
        body: `${projectName}${clientSuffix} has been assigned to you.`
    };
};

const getProjectNotificationEventId = (project, type) => (
    `${type}:${project?._id?.toString() || 'unknown'}`
);

const getRecipientDisplayName = async (recipient, fallback = 'Editor') => {
    if (!recipient) return fallback;
    const resolved = await resolveNotificationRecipient(recipient);
    return resolved.employee?.name || resolved.user?.name || resolved.reference || fallback;
};

const notifyProjectRecipients = async (recipients, title, body, project, type, { sendFcm = true } = {}) => {
    const projectId = project?._id?.toString();
    const eventId = getProjectNotificationEventId(project, type);
    const payload = {
        type: 'project',
        title,
        body,
        url: getProjectNotificationUrl(project),
        entityId: projectId || '',
        eventId,
        tag: eventId
    };
    const extra = { type, eventId };
    if (projectId) extra.projectId = projectId;

    const uniqueRecipients = uniqueIdentityList(recipients);
    await deliverNotificationToReferences(uniqueRecipients, payload, { eventId });
    if (sendFcm) await alarmUsers(uniqueRecipients, title, body, extra);
};

const notifyProjectRecipient = async (recipient, title, body, project, type, options) => {
    await notifyProjectRecipients([recipient], title, body, project, type, options);
};

const getSubmissionNotificationRecipients = (project) => (
    uniqueIdentityList([project.createdByUserId, project.createdByEmail, project.createdBy])
);

const hasUserRole = (user, role) => {
    const roles = Array.isArray(user?.role) ? user.role : [user?.role];
    return roles.includes(role);
};

const isAssignedProjectUser = async (project, user) => {
    const assignedTo = getAssignedEditor(project);
    if (!assignedTo || !user?._id) return false;
    const users = await resolveUsersForReferences([assignedTo]);
    return users.some(recipient => recipient._id.toString() === user._id.toString());
};

const assertProjectMutationAllowed = async (user, project, update, { adminOnly = false } = {}) => {
    if (hasUserRole(user, 'Admin')) return;
    if (adminOnly || !hasUserRole(user, 'Editor') || !await isAssignedProjectUser(project, user)) {
        const error = new Error('You do not have permission to update this project');
        error.statusCode = 403;
        throw error;
    }

    const allowedEditorFields = new Set(['status', 'finalVideoLink', 'resources', 'adminFeedback']);
    if (Object.keys(update).some(field => !allowedEditorFields.has(field))) {
        const error = new Error('Only project submission fields can be updated by the assigned editor');
        error.statusCode = 403;
        throw error;
    }
    if (update.status && !['In Progress', 'Submitted', 'Under Review'].includes(update.status)) {
        const error = new Error('This project status can only be changed by an Admin');
        error.statusCode = 403;
        throw error;
    }
    if (update.adminFeedback) {
        const error = new Error('Admin feedback can only be changed by an Admin');
        error.statusCode = 403;
        throw error;
    }
};

const getCompletedProjectDate = (project) => {
    if (project.status !== 'Completed') return null;

    if (project.completedAt) {
        return { date: project.completedAt, source: 'completedAt' };
    }

    if (project.completedDate) {
        return { date: project.completedDate, source: 'completedDate' };
    }

    if (project.createdAt) {
        return { date: project.createdAt, source: 'legacyCreatedAt' };
    }

    return null;
};

const formatCompletedEditorProject = (project) => {
    const completedDate = getCompletedProjectDate(project);
    if (!completedDate) return null;

    const editor = getAssignedEditor(project);
    if (!editor || editor.toLowerCase() === 'unassigned') return null;

    const date = new Date(completedDate.date);
    if (Number.isNaN(date.getTime())) return null;

    return {
        _id: project._id,
        title: project.title,
        client: project.client,
        projectType: project.projectType,
        budget: Number(project.budget) || 0,
        assignedEditor: editor,
        editor,
        status: project.status,
        completedAt: date.toISOString(),
        completedAtSource: completedDate.source,
        hasRecordedCompletedAt: Boolean(project.completedAt || project.completedDate),
        createdAt: project.createdAt,
        updatedAt: project.updatedAt
    };
};

const resolveClientGuidelines = async (clientName, clientModel = Client) => {
    const resolvedClientName = typeof clientName === 'string'
        ? clientName
        : String(clientName || '');
    if (!resolvedClientName.trim()) return '';

    const client = await clientModel.findOne(
        { name: resolvedClientName },
        { guidelines: 1, _id: 0 }
    ).lean();

    return typeof client?.guidelines === 'string' ? client.guidelines : '';
};

const resolveClientGuidelineData = async (clientName, clientModel = Client) => {
    const resolvedClientName = typeof clientName === 'string'
        ? clientName
        : String(clientName || '');
    if (!resolvedClientName.trim()) return buildClientGuidelineData(null);

    const client = await clientModel.findOne(
        { name: resolvedClientName },
        {
            guidelines: 1,
            guidelineItems: 1,
            guidelineNotes: 1,
            _id: 0
        }
    ).lean();

    return buildClientGuidelineData(client);
};

// সব প্রজেক্ট দেখার API (পেজিনেশন ও মাল্টিপল ফিল্টার সাপোর্ট সহ)
router.get('/', async (req, res) => {
    try {
        const { page, limit, status, client, editor, projectType, paymentStatus, role } = req.query;

        // ডাইনামিক ফিল্টার কুয়েরি তৈরি করা হচ্ছে
        const queryObj = {};

        // ইউজারের রোল ছোট/বড় হাতের যাই হোক না কেন, সেটা চেক করার জন্য
        const isEditorRole = role && role.toLowerCase() === 'editor';

        // এডিটরদের জন্য স্পেশাল রুল: তারা শুধু নির্দিষ্ট স্ট্যাটাসের প্রজেক্ট দেখতে পারবে
        if (isEditorRole) {
            queryObj.status = { $in: ['Pending', 'In Progress', 'Under Review', 'Revision'] };
        } else if (status && status !== 'All') {
            // অ্যাডমিনদের জন্য নরমাল স্ট্যাটাস ফিল্টার
            queryObj.status = status;
        }
        
        if (client && client !== 'All') queryObj.client = client;
        if (projectType && projectType !== 'All') queryObj.projectType = projectType;
        if (paymentStatus && paymentStatus !== 'All') queryObj.paymentStatus = paymentStatus;
        
        // এডিটর ফিল্টারের জন্য স্পেশাল লজিক, কারণ ডাটাবেসে কয়েকটা নামে সেভ থাকতে পারে
        if (editor && editor !== 'All') {
            queryObj.$or = [
                { assignedEditor: editor },
                { editor: editor },
                { assignedTo: editor }
            ];
        }

        // যদি ফ্রন্টএন্ড থেকে page এবং limit না পাঠানো হয় (যাতে ফাইন্যান্স পেজ ঠিক থাকে)
        if (!page || !limit) {
            const projects = await Project.find(queryObj).sort({ createdAt: -1 }).lean();
            
            // ফ্রন্টএন্ডের জন্য এডিটর ফিল্ড ম্যাপ করা হচ্ছে
            const formattedProjects = projects.map(formatProjectForApi);

            return res.status(200).json(formattedProjects);
        }

        // যদি page এবং limit পাঠানো হয়, তবে ব্যাকএন্ড পেজিনেশন কাজ করবে
        const pageNumber = parseInt(page);
        const limitNumber = parseInt(limit);
        const skip = (pageNumber - 1) * limitNumber;

        // ফিল্টার অনুযায়ী ডাটাবেস থেকে নির্দিষ্ট লিমিটের ডাটা এবং মোট সংখ্যা বের করা
        const totalProjects = await Project.countDocuments(queryObj);
        const projects = await Project.find(queryObj)
            .sort({ createdAt: -1 })
            .skip(skip)
            .limit(limitNumber)
            .lean();

        const formattedProjects = projects.map(formatProjectForApi);

        res.status(200).json({
            projects: formattedProjects,
            totalProjects,
            totalPages: Math.ceil(totalProjects / limitNumber),
            currentPage: pageNumber
        });

    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

router.get('/analytics/completed-editor-revenue', async (req, res) => {
    try {
        const projects = await Project.find({ status: 'Completed' }).sort({ createdAt: -1 }).lean();
        const completedEditorProjects = projects
            .map(formatCompletedEditorProject)
            .filter(Boolean);

        const totalValue = completedEditorProjects.reduce((sum, project) => sum + project.budget, 0);
        const projectsWithRecordedCompletedAt = completedEditorProjects.filter(project => project.hasRecordedCompletedAt).length;

        res.status(200).json({
            source: 'projects',
            statusField: 'status',
            requiredStatus: 'Completed',
            editorFields: ['assignedEditor', 'editor', 'assignedTo'],
            dateFields: ['completedAt', 'completedDate'],
            amountField: 'budget',
            legacyDateFallback: 'createdAt',
            excludesPaymentStatus: true,
            totalProjects: completedEditorProjects.length,
            totalValue,
            projectsWithRecordedCompletedAt,
            projectsUsingLegacyDateFallback: completedEditorProjects.length - projectsWithRecordedCompletedAt,
            projects: completedEditorProjects
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

router.get('/:id', async (req, res) => {
    try {
        let project = await Project.findById(req.params.id).lean();
        
        if (project) {
            project = formatProjectForApi(project);
            const guidelineData = await resolveClientGuidelineData(project.client);
            project.clientGuidelines = guidelineData.clientGuidelines;
            project.clientGuidelineProfile = guidelineData.clientGuidelineProfile;
        }

        res.status(200).json(project);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// নতুন প্রজেক্ট — editor-কে ring দাও
router.post('/', authenticate, requireAdmin, async (req, res) => {
    try {
        const safeBody = stripProjectAssignmentLifecycleFields(req.body);
        delete safeBody.createdByUserId;
        delete safeBody.createdBy;
        delete safeBody.createdByEmail;
        delete safeBody._id;
        delete safeBody.__v;

        const projectPayload = {
            ...safeBody,
            createdByUserId: req.user._id,
            createdBy: req.user.name,
            createdByEmail: req.user.email
        };
        if (projectPayload.status === 'Completed' && !projectPayload.completedAt) {
            projectPayload.completedAt = new Date();
        }

        const assignedTo = getAssignedEditor(projectPayload);
        let assignedEditorUser = null;
        if (assignedTo && !isUnassignedReference(assignedTo) && !isTerminalProjectStatus(projectPayload.status)) {
            assignedEditorUser = await resolveAssignedEditorUser(assignedTo);
            projectPayload.assignedEditor = assignedTo;
            projectPayload.editor = assignedTo;
            Object.assign(projectPayload, buildPendingAssignmentFields({
                project: null,
                assignedEditorUser,
                now: new Date()
            }));
        }

        const newProject = new Project(projectPayload);
        const savedProject = await newProject.save();

        if (assignedEditorUser) {
            try {
                await publishProjectAssignmentEvent({
                    project: savedProject,
                    action: 'assigned',
                    reason: 'assigned',
                    recipientUserIds: [assignedEditorUser._id],
                    includeAdmins: true,
                    sendMobile: true
                });
                const { title, body } = buildProjectAssignmentCopy(savedProject);
                await notifyProjectRecipient(
                    assignedTo,
                    title,
                    body,
                    savedProject,
                    'new_project',
                    { sendFcm: false }
                );
            } catch (error) {
                console.error('Project assignment notification failed:', error.message);
            }
        }

        res.status(201).json(formatProjectForApi(savedProject));
    } catch (err) {
        res.status(err.statusCode || (err.name === 'ValidationError' ? 400 : 500)).json({
            error: err.message,
            ...(err.code && typeof err.code === 'string' ? { code: err.code } : {})
        });
    }
});

// প্রজেক্ট আপডেট (PUT) — Frontend থেকে Quick Editor চেঞ্জ বা ফুল আপডেটের জন্য
router.put('/:id', authenticate, async (req, res) => {
    try {
        const oldProject = await Project.findById(req.params.id);
        const update = buildProjectUpdate(req.body, oldProject);
        if (!oldProject) return res.status(404).json({ error: 'Project not found' });
        await assertProjectMutationAllowed(req.user, oldProject, update, { adminOnly: true });

        const transition = await prepareProjectAssignmentTransition(oldProject, update);
        const updatedProject = await updateProjectById(req.params.id, update, oldProject, {
            assignmentTransition: transition.changed
        });

        if (!updatedProject) {
            return res.status(transition.changed ? 409 : 404).json({
                error: transition.changed
                    ? 'The project assignment changed while this update was being saved. Refresh and try again.'
                    : 'Project not found',
                ...(transition.changed ? { code: 'PROJECT_ASSIGNMENT_CONFLICT' } : {})
            });
        }

        await publishAssignmentTransitionSafely({ oldProject, updatedProject, transition });

        res.status(200).json(formatProjectForApi(updatedProject));
    } catch (err) {
        res.status(err.statusCode || 500).json({ error: err.message });
    }
});

// প্রজেক্ট আপডেট (PATCH) — revision হলে editor-কে ring দাও
router.patch('/:id', authenticate, async (req, res) => {
    try {
        const oldProject = await Project.findById(req.params.id);
        const update = buildProjectUpdate(req.body, oldProject);
        if (!oldProject) return res.status(404).json({ error: 'Project not found' });
        await assertProjectMutationAllowed(req.user, oldProject, update);

        const transition = await prepareProjectAssignmentTransition(oldProject, update);
        const updatedProject = await updateProjectById(req.params.id, update, oldProject, {
            assignmentTransition: transition.changed
        });

        if (!updatedProject) {
            return res.status(transition.changed ? 409 : 404).json({
                error: transition.changed
                    ? 'The project assignment changed while this update was being saved. Refresh and try again.'
                    : 'Project not found',
                ...(transition.changed ? { code: 'PROJECT_ASSIGNMENT_CONFLICT' } : {})
            });
        }
        await publishAssignmentTransitionSafely({ oldProject, updatedProject, transition });

        const projName = updatedProject.title || updatedProject.projectName || '';
        const assignedTo = getAssignedEditor(updatedProject);

        // 1. Editor submitted → notify only the recorded project creator.
        if (REVIEW_STATUSES.has(req.body.status) && !REVIEW_STATUSES.has(oldProject.status)) {
            const recipients = await getSubmissionNotificationRecipients(updatedProject);
            if (recipients.length) {
                void (async () => {
                    const editorName = await getRecipientDisplayName(assignedTo);
                    await notifyProjectRecipients(
                        recipients,
                        'Project Submitted',
                        `${editorName} submitted: ${projName}`,
                        updatedProject,
                        'project_submitted'
                    );
                })().catch(error => console.error('Project submission notification failed:', error.message));
            }
        }
        // 2. Admin requested revision → RING THE EDITOR
        else if (req.body.status === 'Revision' && oldProject.status !== 'Revision') {
            if (assignedTo) {
                const title = 'Revision Needed';
                const body = `Admin requested revision for: ${projName}`;

                void notifyProjectRecipient(assignedTo, title, body, updatedProject, 'revision_needed')
                    .catch(error => console.error('Project revision notification failed:', error.message));
            }
        }

        res.status(200).json(formatProjectForApi(updatedProject));
    } catch (err) {
        res.status(err.statusCode || 500).json({ error: err.message });
    }
});

router.delete('/:id', authenticate, async (req, res) => {
    try {
        const project = await Project.findById(req.params.id);
        if (!project) return res.status(404).json({ error: 'Project not found' });
        await assertProjectMutationAllowed(req.user, project, {}, { adminOnly: true });
        await Project.findByIdAndDelete(req.params.id);
        if (project.assignmentStatus === 'pending') {
            await (async () => {
                const recipient = await resolveProjectAssignedUser(project);
                if (!recipient) return;
                await publishAssignmentTransition({
                    oldProject: project,
                    updatedProject: null,
                    transition: {
                        changed: true,
                        oldRecipientUser: recipient,
                        newRecipientUser: null,
                        newEditor: '',
                        reason: 'project_deleted'
                    }
                });
            })().catch(error => console.error('Deleted project assignment cancellation failed:', error.message));
        }
        res.status(200).json({ message: 'Project deleted successfully' });
    } catch (err) {
        res.status(err.statusCode || 500).json({ error: err.message });
    }
});

module.exports = router;
module.exports.buildAssignmentTransitionDeliveries = buildAssignmentTransitionDeliveries;
module.exports.buildProjectAssignmentCopy = buildProjectAssignmentCopy;
module.exports.buildProjectUpdate = buildProjectUpdate;
module.exports.formatProjectForApi = formatProjectForApi;
module.exports.getProjectNotificationEventId = getProjectNotificationEventId;
module.exports.getSubmissionNotificationRecipients = getSubmissionNotificationRecipients;
module.exports.getProjectNotificationUrl = getProjectNotificationUrl;
module.exports.getProjectUpdateFilter = getProjectUpdateFilter;
module.exports.prepareProjectAssignmentTransition = prepareProjectAssignmentTransition;
module.exports.resolveClientGuidelineData = resolveClientGuidelineData;
module.exports.resolveClientGuidelines = resolveClientGuidelines;
