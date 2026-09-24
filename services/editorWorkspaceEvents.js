const EditorWorkspaceEvent = require('../models/EditorWorkspaceEvent');

const recordEditorWorkspaceEvent = async (userIds, event) => {
    if (!event?.eventId) return;
    const data = Object.fromEntries([
        'type', 'action', 'reason', 'eventId', 'projectId', 'projectName',
        'assignmentRequestId', 'assignmentVersion', 'title', 'body', 'targetSection', 'url'
    ].filter(key => event[key] !== undefined).map(key => [key, event[key]]));
    // A replay keeps the original timestamp and identity.
    await Promise.all([...new Set(userIds.map(String))].map(userId => (
        EditorWorkspaceEvent.updateOne({ userId, eventId: event.eventId }, {
            $setOnInsert: { data, createdAt: new Date(event.createdAt || Date.now()) }
        }, { upsert: true })
    )));
};

const getEditorWorkspaceEvents = async userId => {
    const entries = await EditorWorkspaceEvent.find({ userId }).sort({ createdAt: -1, _id: -1 }).limit(200).lean();
    return entries.map(entry => ({ ...entry.data, createdAt: entry.createdAt.toISOString() }));
};

module.exports = { recordEditorWorkspaceEvent, getEditorWorkspaceEvents };
