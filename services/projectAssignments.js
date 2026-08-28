const mongoose = require('mongoose');
const { resolveUsersForReferences } = require('./pushRecipients');

const DEFAULT_ASSIGNMENT_TIMEOUT_SECONDS = 2 * 60;
const MIN_ASSIGNMENT_TIMEOUT_SECONDS = 30;
const MAX_ASSIGNMENT_TIMEOUT_SECONDS = 60 * 60;

const ASSIGNMENT_LIFECYCLE_FIELDS = new Set([
    'assignedEditorUserId',
    'assignmentStatus',
    'assignmentRequestId',
    'assignmentVersion',
    'assignedAt',
    'deliveredAt',
    'acceptedAt',
    'assignmentExpiresAt',
    'acceptedBy'
]);

const TERMINAL_PROJECT_STATUSES = new Set(['completed', 'cancelled', 'canceled']);
const ACTIVE_PROJECT_STATUSES = Object.freeze([
    'Pending',
    'In Progress',
    'Submitted',
    'Under Review',
    'Revision'
]);
const LEGACY_EDITOR_FIELDS = Object.freeze(['assignedEditor', 'editor', 'assignedTo']);

const createHttpError = (message, statusCode = 400, code = '') => {
    const error = new Error(message);
    error.statusCode = statusCode;
    if (code) error.code = code;
    return error;
};

const getAssignmentTimeoutSeconds = () => {
    const configured = Number(process.env.PROJECT_ASSIGNMENT_ALERT_TIMEOUT_SECONDS);
    if (!Number.isFinite(configured)) return DEFAULT_ASSIGNMENT_TIMEOUT_SECONDS;
    return Math.min(
        MAX_ASSIGNMENT_TIMEOUT_SECONDS,
        Math.max(MIN_ASSIGNMENT_TIMEOUT_SECONDS, Math.round(configured))
    );
};

const stripProjectAssignmentLifecycleFields = (value = {}) => {
    const safe = { ...value };
    ASSIGNMENT_LIFECYCLE_FIELDS.forEach(field => delete safe[field]);
    return safe;
};

const normalizeEditorReference = value => String(value || '').trim();

const isUnassignedReference = value => {
    const normalized = normalizeEditorReference(value).toLowerCase();
    return !normalized || normalized === 'unassigned' || normalized === 'none';
};

const isTerminalProjectStatus = value => (
    TERMINAL_PROJECT_STATUSES.has(String(value || '').trim().toLowerCase())
);

const hasRole = (user, role) => {
    const roles = Array.isArray(user?.role) ? user.role : [user?.role];
    return roles.includes(role);
};

const resolveAssignedEditorUser = async (reference) => {
    if (isUnassignedReference(reference)) return null;
    const users = await resolveUsersForReferences([reference]);
    const user = users[0] || null;
    if (!user) {
        throw createHttpError(
            'The assigned editor does not have an active Fortivus login account',
            400,
            'ASSIGNED_EDITOR_ACCOUNT_NOT_FOUND'
        );
    }
    if (!hasRole(user, 'Editor')) {
        throw createHttpError(
            'The selected account does not have the Editor role',
            400,
            'ASSIGNED_USER_IS_NOT_EDITOR'
        );
    }
    return user;
};

const resolveProjectAssignedUser = async project => {
    if (project?.assignedEditorUserId) {
        const users = await resolveUsersForReferences([project.assignedEditorUserId]);
        if (users[0]) return users[0];
        // Stop/cancellation events must still reach the installation registry
        // when the old account was disabled after assignment. The immutable ID
        // is sufficient; no profile data is included in that event.
        return { _id: project.assignedEditorUserId };
    }
    const reference = project?.assignedEditor || project?.editor || project?.assignedTo;
    if (isUnassignedReference(reference)) return null;
    const users = await resolveUsersForReferences([reference]);
    return users[0] || null;
};

const escapeRegExp = value => String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// New projects are scoped by an immutable user ID. During rollout, older
// production records may only contain a display name/email in one of the
// legacy editor fields. Limit the compatibility candidates to exact references
// belonging to the authenticated editor; they are resolved and verified again
// below before any project is returned.
const buildActiveProjectFilter = user => {
    const userId = String(user?._id || '').trim();
    if (!userId) {
        return {
            _id: null,
            status: { $in: [...ACTIVE_PROJECT_STATUSES] }
        };
    }

    const legacyReferences = [...new Set([
        userId,
        String(user?.email || '').trim(),
        String(user?.name || '').trim()
    ].filter(Boolean))].map(reference => new RegExp(`^\\s*${escapeRegExp(reference)}\\s*$`, 'i'));

    return {
        status: { $in: [...ACTIVE_PROJECT_STATUSES] },
        $or: [
            { assignedEditorUserId: user._id },
            {
                // `{ field: null }` intentionally matches both null and missing
                // values, but never overrides an immutable ID belonging to a
                // different editor.
                assignedEditorUserId: null,
                $or: LEGACY_EDITOR_FIELDS.map(field => ({
                    [field]: { $in: legacyReferences }
                }))
            }
        ]
    };
};

const filterActiveProjectsForUser = async (
    projects,
    user,
    resolveAssignedUser = resolveProjectAssignedUser
) => {
    const userId = String(user?._id || '').trim();
    if (!userId) return [];

    const verified = await Promise.all((Array.isArray(projects) ? projects : []).map(async project => {
        const immutableUserId = String(project?.assignedEditorUserId || '').trim();
        if (immutableUserId) return immutableUserId === userId ? project : null;

        const resolvedUser = await resolveAssignedUser(project);
        return String(resolvedUser?._id || '').trim() === userId ? project : null;
    }));
    return verified.filter(Boolean);
};

const nextAssignmentVersion = project => Math.max(0, Number(project?.assignmentVersion) || 0) + 1;

const buildPendingAssignmentFields = ({ project, assignedEditorUser, now = new Date() }) => {
    if (!assignedEditorUser?._id) {
        throw createHttpError('An active editor account is required', 400, 'ASSIGNED_EDITOR_ACCOUNT_NOT_FOUND');
    }
    const timeoutSeconds = getAssignmentTimeoutSeconds();
    return {
        assignedEditorUserId: assignedEditorUser._id,
        assignmentStatus: 'pending',
        assignmentRequestId: new mongoose.Types.ObjectId().toString(),
        assignmentVersion: nextAssignmentVersion(project),
        assignedAt: now,
        deliveredAt: null,
        acceptedAt: null,
        assignmentExpiresAt: new Date(now.getTime() + (timeoutSeconds * 1000)),
        acceptedBy: { userId: null, name: '' }
    };
};

const buildClearedAssignmentFields = (project) => ({
    assignedEditorUserId: null,
    assignmentStatus: null,
    assignmentRequestId: null,
    assignmentVersion: nextAssignmentVersion(project),
    assignedAt: null,
    deliveredAt: null,
    acceptedAt: null,
    assignmentExpiresAt: null,
    acceptedBy: { userId: null, name: '' }
});

const parseAssignmentVersion = value => {
    const version = Number(value);
    return Number.isInteger(version) && version > 0 ? version : null;
};

const buildAcceptedBySnapshot = user => ({
    userId: user?._id,
    name: String(user?.name || '')
});

// A delivery acknowledgement is accepted only from the currently assigned
// editor. The null predicate makes the first device win atomically, so a later
// device can never move the earliest deliveredAt timestamp forward.
const acknowledgeProjectAssignmentDelivery = async ({
    ProjectModel,
    requestId,
    userId,
    now = new Date()
}) => {
    const updatedProject = await ProjectModel.findOneAndUpdate(
        {
            assignmentRequestId: requestId,
            assignedEditorUserId: userId,
            assignmentStatus: 'pending',
            deliveredAt: null
        },
        { $set: { deliveredAt: now } },
        { new: true, runValidators: true }
    );

    if (updatedProject) return { project: updatedProject, newlyDelivered: true };

    const project = await ProjectModel.findOne({
        assignmentRequestId: requestId,
        assignedEditorUserId: userId
    });
    if (!project || project.assignmentStatus !== 'pending') {
        throw createHttpError(
            'This assignment is no longer waiting for acceptance',
            409,
            'ASSIGNMENT_NO_LONGER_PENDING'
        );
    }
    return { project, newlyDelivered: false };
};

// Acceptance is a compare-and-set on the immutable request id, monotonically
// increasing version, current assignee and pending status. Notice that the
// ringing deadline is intentionally absent: it controls sound/vibration only.
const acceptProjectAssignment = async ({
    ProjectModel,
    requestId,
    assignmentVersion,
    user,
    now = new Date()
}) => {
    const acceptedBy = buildAcceptedBySnapshot(user);
    const acceptedProject = await ProjectModel.findOneAndUpdate(
        {
            assignmentRequestId: requestId,
            assignmentVersion,
            assignedEditorUserId: user._id,
            assignmentStatus: 'pending'
        },
        [
            {
                $set: {
                    assignmentStatus: 'accepted',
                    acceptedAt: now,
                    deliveredAt: { $ifNull: ['$deliveredAt', now] },
                    acceptedBy
                }
            }
        ],
        { new: true }
    );

    if (acceptedProject) return { project: acceptedProject, alreadyAccepted: false };

    const project = await ProjectModel.findOne({
        assignmentRequestId: requestId,
        assignmentVersion,
        assignedEditorUserId: user._id
    });
    if (
        project?.assignmentStatus === 'accepted' &&
        String(project.acceptedBy?.userId || '') === String(user._id)
    ) {
        return { project, alreadyAccepted: true };
    }

    throw createHttpError(
        'This assignment is no longer waiting for acceptance',
        409,
        'ASSIGNMENT_NO_LONGER_PENDING'
    );
};

const toIsoString = value => {
    if (!value) return '';
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? '' : date.toISOString();
};

const getProjectUrl = project => (
    project?._id ? `/project/${String(project._id)}` : '/projects'
);

const formatAcceptedBy = acceptedBy => ({
    userId: String(acceptedBy?.userId || ''),
    name: String(acceptedBy?.name || '')
});

const formatAssignmentForClient = project => ({
    assignmentRequestId: String(project?.assignmentRequestId || ''),
    assignmentVersion: Number(project?.assignmentVersion) || 0,
    assignmentStatus: String(project?.assignmentStatus || ''),
    projectId: String(project?._id || ''),
    projectName: String(project?.title || project?.projectName || 'Untitled Project'),
    clientName: String(project?.client || ''),
    deadline: toIsoString(project?.deadline),
    priority: String(project?.priority || 'Normal'),
    assignedAt: toIsoString(project?.assignedAt),
    deliveredAt: toIsoString(project?.deliveredAt),
    acceptedAt: toIsoString(project?.acceptedAt),
    assignmentExpiresAt: toIsoString(project?.assignmentExpiresAt),
    ringTimeoutSeconds: getAssignmentTimeoutSeconds(),
    acceptedBy: formatAcceptedBy(project?.acceptedBy),
    projectUrl: getProjectUrl(project)
});

const serializeProjectForApi = project => {
    if (!project) return project;
    const value = typeof project.toObject === 'function' ? project.toObject() : { ...project };
    if (value.acceptedBy) value.acceptedBy = formatAcceptedBy(value.acceptedBy);
    return value;
};

module.exports = {
    ACTIVE_PROJECT_STATUSES,
    ASSIGNMENT_LIFECYCLE_FIELDS,
    DEFAULT_ASSIGNMENT_TIMEOUT_SECONDS,
    acceptProjectAssignment,
    acknowledgeProjectAssignmentDelivery,
    buildActiveProjectFilter,
    buildAcceptedBySnapshot,
    buildClearedAssignmentFields,
    buildPendingAssignmentFields,
    createHttpError,
    formatAssignmentForClient,
    filterActiveProjectsForUser,
    getAssignmentTimeoutSeconds,
    getProjectUrl,
    hasRole,
    isTerminalProjectStatus,
    isUnassignedReference,
    normalizeEditorReference,
    parseAssignmentVersion,
    resolveAssignedEditorUser,
    resolveProjectAssignedUser,
    serializeProjectForApi,
    stripProjectAssignmentLifecycleFields,
    toIsoString
};
