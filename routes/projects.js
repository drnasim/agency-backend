const express = require('express');
const router = express.Router();
const Project = require('../models/Project');
const Client = require('../models/Client');
const { alarmUsers } = require('../fcm');
const { resolveNotificationRecipient } = require('../utils/notificationRecipients');
const { authenticate } = require('../middleware/authenticate');
const { deliverNotificationToReferences } = require('../services/notificationDelivery');
const { resolveUsersForReferences } = require('../services/pushRecipients');

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
    const update = { ...body };

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

const updateProjectById = async (projectId, update, oldProject) => {
    if (!hasOwn(update, 'createdAt')) {
        return Project.findByIdAndUpdate(
            projectId,
            { $set: update },
            { new: true }
        );
    }

    if (!oldProject) return null;

    const { createdAt, ...schemaUpdate } = update;
    if (Object.keys(schemaUpdate).length > 0) {
        const schemaUpdatedProject = await Project.findByIdAndUpdate(
            projectId,
            { $set: schemaUpdate },
            { new: true }
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

const notifyProjectRecipients = async (recipients, title, body, project, type) => {
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
    await alarmUsers(uniqueRecipients, title, body, extra);
};

const notifyProjectRecipient = async (recipient, title, body, project, type) => {
    await notifyProjectRecipients([recipient], title, body, project, type);
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
            const formattedProjects = projects.map(project => ({
                ...project,
                editor: project.editor || project.assignedTo || project.assignedEditor || 'Unassigned'
            }));

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

        const formattedProjects = projects.map(project => ({
            ...project,
            editor: project.editor || project.assignedTo || project.assignedEditor || 'Unassigned'
        }));

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
        const project = await Project.findById(req.params.id).lean();
        
        if (project) {
            project.editor = project.editor || project.assignedTo || project.assignedEditor || 'Unassigned';
            project.clientGuidelines = await resolveClientGuidelines(project.client);
        }

        res.status(200).json(project);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// নতুন প্রজেক্ট — editor-কে ring দাও
router.post('/', authenticate, async (req, res) => {
    try {
        const projectPayload = {
            ...req.body,
            createdByUserId: req.user._id,
            createdBy: req.user.name,
            createdByEmail: req.user.email
        };
        if (projectPayload.status === 'Completed' && !projectPayload.completedAt) {
            projectPayload.completedAt = new Date();
        }

        const newProject = new Project(projectPayload);
        const savedProject = await newProject.save();

        const assignedTo = getAssignedEditor(savedProject);
        if (assignedTo) {
            // Delivery is detached so push/FCM failures cannot fail or delay an
            // otherwise successful project creation. Assignment remains authoritative,
            // including when the creator is also the assigned recipient.
            void (async () => {
                const { title, body } = buildProjectAssignmentCopy(savedProject);
                await notifyProjectRecipient(assignedTo, title, body, savedProject, 'new_project');
            })().catch(error => console.error('Project assignment notification failed:', error.message));
        }

        res.status(201).json(savedProject);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// প্রজেক্ট আপডেট (PUT) — Frontend থেকে Quick Editor চেঞ্জ বা ফুল আপডেটের জন্য
router.put('/:id', authenticate, async (req, res) => {
    try {
        const oldProject = await Project.findById(req.params.id);
        const update = buildProjectUpdate(req.body, oldProject);
        if (!oldProject) return res.status(404).json({ error: 'Project not found' });
        await assertProjectMutationAllowed(req.user, oldProject, update, { adminOnly: true });
        
        const updatedProject = await updateProjectById(req.params.id, update, oldProject);

        if (!updatedProject) return res.status(404).json({ error: 'Project not found' });

        // যদি লিস্ট থেকে এডিটর পরিবর্তন করা হয়, তবে নতুন এডিটরকে নোটিফিকেশন পাঠাবে
        if (oldProject) {
            const oldEditor = getAssignedEditor(oldProject);
            const newEditor = getAssignedEditor(updatedProject);

            // এডিটর চেঞ্জ হয়েছে কিনা চেক করা হচ্ছে
            if (newEditor && String(oldEditor) !== String(newEditor)) {
                const title = 'Project Re-assigned';
                const body = `${updatedProject.title || updatedProject.projectName || 'A project'} has been re-assigned to you.`;

                void notifyProjectRecipient(newEditor, title, body, updatedProject, 'new_project')
                    .catch(error => console.error('Project reassignment notification failed:', error.message));
            }
        }

        res.status(200).json(updatedProject);
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

        const updatedProject = await updateProjectById(req.params.id, update, oldProject);

        if (!updatedProject) return res.status(404).json({ error: 'Project not found' });
        if (!oldProject) return res.status(200).json(updatedProject);

        const projName = updatedProject.title || updatedProject.projectName || '';
        const assignedTo = getAssignedEditor(updatedProject);
        const oldEditor = getAssignedEditor(oldProject);

        if (assignedTo && String(oldEditor) !== String(assignedTo)) {
            const title = 'Project Re-assigned';
            const body = `${updatedProject.title || updatedProject.projectName || 'A project'} has been re-assigned to you.`;

            void notifyProjectRecipient(assignedTo, title, body, updatedProject, 'new_project')
                .catch(error => console.error('Project reassignment notification failed:', error.message));
        }

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

        res.status(200).json(updatedProject);
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
        res.status(200).json({ message: 'Project deleted successfully' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

module.exports = router;
module.exports.buildProjectAssignmentCopy = buildProjectAssignmentCopy;
module.exports.buildProjectUpdate = buildProjectUpdate;
module.exports.getProjectNotificationEventId = getProjectNotificationEventId;
module.exports.getSubmissionNotificationRecipients = getSubmissionNotificationRecipients;
module.exports.getProjectNotificationUrl = getProjectNotificationUrl;
module.exports.resolveClientGuidelines = resolveClientGuidelines;
