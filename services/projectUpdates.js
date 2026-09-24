const { resolveProjectAssignedUser, isTerminalProjectStatus } = require('./projectAssignments');
const { recordEditorWorkspaceEvent } = require('./editorWorkspaceEvents');
const { deliverNotificationToReferences } = require('./notificationDelivery');
const { alarmUsers } = require('../fcm');

const changed = (before, after, keys) => keys.some(key => (
    JSON.stringify(before?.[key] ?? null) !== JSON.stringify(after?.[key] ?? null)
));
const describeProjectChanges = (before, after) => {
    const updates = [];
    if (changed(before, after, ['deadline'])) updates.push(['deadline_changed', 'Deadline changed', 'deadlines']);
    if (after.status === 'Revision' && changed(before, after, ['status', 'adminFeedback'])) {
        updates.push(['revision_needed', 'Revision requested', 'revisions']);
    } else if (changed(before, after, ['status'])) updates.push(['project_status_changed', 'Project status changed', 'updates']);
    if (changed(before, after, ['title', 'projectName', 'notes', 'resources', 'priority', 'projectType', 'duration', 'client'])) {
        updates.push(['project_details_updated', 'Project brief updated', 'updates']);
    }
    return updates;
};

const publishEditorProjectUpdate = async (project, type, title, targetSection, revision = project.updatedAt) => {
    if (isTerminalProjectStatus(project.status)) return;
    const user = await resolveProjectAssignedUser(project);
    if (!user) return;
    const projectId = String(project._id);
    const projectName = project.title || project.projectName || 'Project';
    const eventId = `${type}:${projectId}:${new Date(revision || Date.now()).getTime()}`;
    const event = { type, title, body: `${title}: ${projectName}`, projectName, projectId,
        assignmentVersion: project.assignmentVersion || 0, eventId, targetSection, url: `/project/${projectId}` };
    await recordEditorWorkspaceEvent([user._id], event);
    await Promise.allSettled([
        deliverNotificationToReferences([String(user._id)], { ...event, entityId: projectId }, { eventId }),
        alarmUsers([String(user._id)], event.title, event.body, event)
    ]);
};

const publishProjectChanges = async (before, after, transition) => {
    if (transition?.changed) return; // Assignment events already describe this mutation.
    for (const [type, title, section] of describeProjectChanges(before, after)) {
        await publishEditorProjectUpdate(after, type, title, section);
    }
};
module.exports = { describeProjectChanges, publishEditorProjectUpdate, publishProjectChanges };
