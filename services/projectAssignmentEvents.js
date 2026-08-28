const User = require('../models/User');
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

const getEventCopy = (project, action) => {
    const projectName = project?.title || project?.projectName || 'A project';
    const clientSuffix = project?.client ? ` for ${project.client}` : '';
    if (action === 'assigned') {
        return { title: 'New Project Assigned', body: `${projectName}${clientSuffix} has been assigned to you.` };
    }
    if (action === 'reassigned') {
        return { title: 'Project Re-assigned', body: `${projectName}${clientSuffix} has been re-assigned to you.` };
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
    const copy = getEventCopy(project, action);
    return {
        ...assignment,
        action,
        reason: String(reason || ''),
        eventId: `project_assignment:${assignment.assignmentRequestId || assignment.projectId}:${action}:${assignment.assignmentVersion}`,
        title: copy.title,
        body: copy.body,
        acceptedByUserId: assignment.acceptedBy.userId,
        acceptedByName: assignment.acceptedBy.name
    };
};

const publishProjectAssignmentEvent = async ({
    project,
    action,
    reason = '',
    recipientUserIds = [],
    includeAdmins = true,
    sendMobile = true,
    io = global.io
}) => {
    const directRecipientIds = uniqueIds(recipientUserIds);
    let adminIds = [];
    if (includeAdmins) {
        try {
            adminIds = await getAdminUserIds();
        } catch (error) {
            console.error('Project assignment Admin lookup failed:', error.message);
        }
    }
    const event = buildProjectAssignmentEvent(project, action, reason);
    const realtimeUserIds = uniqueIds([...directRecipientIds, ...adminIds]);
    emitProjectAssignmentEventToUserIds(io, realtimeUserIds, event);

    let mobileResults = [];
    if (sendMobile && directRecipientIds.length) {
        mobileResults = await sendProjectAssignmentEventToUsers(directRecipientIds, event);
    }
    return { event, realtimeUserIds, mobileResults };
};

module.exports = {
    buildProjectAssignmentEvent,
    getAdminUserIds,
    getEventCopy,
    publishProjectAssignmentEvent,
    uniqueIds
};
