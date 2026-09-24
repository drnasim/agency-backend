const User = require('../models/User');
const { recordEditorWorkspaceEvent } = require('./editorWorkspaceEvents');
const { sendProjectAssignmentEventToUsers } = require('../fcm');
const { emitProjectAssignmentEventToUserIds } = require('./socketNotifications');
const { formatAssignmentForClient } = require('./projectAssignments');

const uniqueIds = values => [...new Set((values || [])
    .map(value => String(value || '').trim())
    .filter(Boolean))];

const getAdminUserIds = async () => {
    const admins = await User.find({ role: 'Admin', isActive: { $ne: false } })
        .select('_id')
        .lean();
    return admins.map(admin => admin._id.toString());
};

const getEventCopy = (project, action, reason = '') => {
    const projectName = project?.title || project?.projectName || 'A project';
    const clientSuffix = project?.client ? ` for ${project.client}` : '';
    if (reason === 'project_completed') return { title: 'Project completed', body: `${projectName} is complete and has left your active projects.` };
    if (reason === 'project_deleted') return { title: 'Project removed', body: `${projectName} was deleted by an administrator.` };
    if (reason === 'unassigned') return { title: 'Assignment removed', body: `${projectName} is no longer assigned to you.` };
    if (reason === 'project_cancelled') return { title: 'Project cancelled', body: `${projectName} was cancelled.` };
    if (action === 'assigned') {
        return { title: 'New Project Assigned', body: `${projectName}${clientSuffix} has been assigned to you.` };
    }
    if (action === 'reassigned') {
        return { title: 'Project Re-assigned', body: `${projectName}${clientSuffix} is no longer assigned to you.` };
    }
    if (action === 'accepted') {
        return { title: 'Project Accepted', body: `${projectName} was accepted.` };
    }
    if (action === 'delivered') {
        return { title: 'Project Request Delivered', body: `${projectName} reached an editor device.` };
    }
    return { title: 'Project Assignment Cancelled', body: `${projectName} is no longer awaiting your acceptance.` };
};

const buildProjectAssignmentEvent = (project, action, reason = '') => {
    const assignment = formatAssignmentForClient(project);
    const copy = getEventCopy(project, action, reason);
    return {
        ...assignment,
        type: 'project_assignment',
        createdAt: new Date().toISOString(),
        action,
        reason: String(reason || ''),
        eventId: `project_assignment:${assignment.assignmentRequestId || assignment.projectId}:${action}:${assignment.assignmentVersion}${action === 'cancelled' ? `:${reason}` : ''}`,
        title: copy.title,
        body: copy.body,
        acceptedByUserId: assignment.acceptedBy.userId,
        acceptedByName: assignment.acceptedBy.name
    };
};

const createProjectAssignmentPublisher = ({
    getAdminIds = getAdminUserIds,
    emitRealtime = emitProjectAssignmentEventToUserIds,
    sendMobileEvents = sendProjectAssignmentEventToUsers,
    recordEvent = recordEditorWorkspaceEvent,
    logger = console
} = {}) => async ({
    project,
    action,
    reason = '',
    recipientUserIds = [],
    includeAdmins = true,
    sendMobile = true,
    io = global.io
}) => {
    const directRecipientIds = uniqueIds(recipientUserIds);
    const event = buildProjectAssignmentEvent(project, action, reason);

    // FCM is the durable assignment-alert channel. Start it before any Admin
    // lookup or Socket.IO work so a slow/broken realtime layer cannot delay or
    // suppress delivery to a sleeping Android device.
    const mobileDelivery = sendMobile && directRecipientIds.length
        ? sendMobileEvents(directRecipientIds, event).catch(error => {
            logger.error('Project assignment FCM delivery failed:', error.message);
            return [];
        })
        : Promise.resolve([]);

    // Persist lifecycle outcomes for editors who were offline or missed push.
    if (['cancelled', 'reassigned', 'accepted'].includes(action) && directRecipientIds.length) {
        try { await recordEvent(directRecipientIds, event); }
        catch (error) { logger.error('Editor workspace event persistence failed:', error.message); }
    }

    let adminIds = [];
    if (includeAdmins) {
        try {
            adminIds = await getAdminIds();
        } catch (error) {
            logger.error('Project assignment Admin lookup failed:', error.message);
        }
    }
    const realtimeUserIds = uniqueIds([...directRecipientIds, ...adminIds]);
    let realtimeEmitted = 0;
    try {
        realtimeEmitted = emitRealtime(io, realtimeUserIds, event);
    } catch (error) {
        logger.error('Project assignment realtime delivery failed:', error.message);
    }

    const mobileResults = await mobileDelivery;
    return { event, realtimeUserIds, realtimeEmitted, mobileResults };
};

const publishProjectAssignmentEvent = createProjectAssignmentPublisher();

module.exports = {
    buildProjectAssignmentEvent,
    createProjectAssignmentPublisher,
    getAdminUserIds,
    getEventCopy,
    publishProjectAssignmentEvent,
    uniqueIds
};
