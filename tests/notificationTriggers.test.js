const test = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const { buildMessagePush, getRoomMemberReferences, getSafeMessagePreview } = require('../routes/chat');
const {
    buildProjectAssignmentCopy,
    buildProjectUpdate,
    getProjectNotificationEventId,
    getProjectNotificationUrl,
    getSubmissionNotificationRecipients
} = require('../routes/projects');

test('message trigger builds a unique chat destination and excludes every sender identity', () => {
    const roomId = new mongoose.Types.ObjectId();
    const messageId = new mongoose.Types.ObjectId();
    const senderId = new mongoose.Types.ObjectId();
    const notification = buildMessagePush({
        savedMessage: { _id: messageId, text: 'A private preview', fileUrl: '' },
        room: { _id: roomId, name: 'Private', isGroup: false, members: ['Sender', 'Recipient'] },
        sender: { _id: senderId, name: 'Sender', email: 'sender@example.com' }
    });
    assert.equal(notification.payload.type, 'message');
    assert.equal(notification.payload.url, `/dashboard?chat=${roomId}`);
    assert.equal(notification.eventId, `message:${messageId}`);
    assert.equal(notification.payload.senderUserId, senderId.toString());
    assert.deepEqual(notification.excludeReferences.map(String), [senderId.toString(), 'Sender', 'sender@example.com']);
    assert.deepEqual(notification.references, ['Sender', 'Recipient']);
});

test('new conversation notifications prefer immutable member user IDs', () => {
    const roomId = new mongoose.Types.ObjectId();
    const messageId = new mongoose.Types.ObjectId();
    const senderId = new mongoose.Types.ObjectId();
    const recipientId = new mongoose.Types.ObjectId();
    const notification = buildMessagePush({
        savedMessage: { _id: messageId, text: 'Hello', fileUrl: '' },
        room: {
            _id: roomId,
            name: 'Private',
            isGroup: false,
            members: ['Legacy Sender', 'Legacy Recipient'],
            memberUserIds: [senderId, recipientId]
        },
        sender: { _id: senderId, name: 'Sender', email: 'sender@example.com' }
    });
    assert.deepEqual(notification.references.map(String), [senderId.toString(), recipientId.toString()]);
});

test('partially migrated conversations retain legacy recipient references', () => {
    const migratedUserId = new mongoose.Types.ObjectId();
    const references = getRoomMemberReferences({
        memberUserIds: [migratedUserId],
        members: ['Migrated User', 'Legacy Recipient']
    });
    assert.deepEqual(references.map(String), [
        migratedUserId.toString(),
        'Migrated User',
        'Legacy Recipient'
    ]);
});

test('message preview is bounded and does not expose the full message', () => {
    const longText = 'private '.repeat(30);
    const preview = getSafeMessagePreview(longText, false);
    assert.ok(preview.length <= 81);
    assert.ok(preview.endsWith('…'));
    assert.equal(getSafeMessagePreview('', true), 'Sent an attachment');
});

test('message preview truncation does not split Unicode code points', () => {
    const preview = getSafeMessagePreview('😀'.repeat(81), false);
    assert.equal(preview, `${'😀'.repeat(80)}…`);
    assert.equal(preview.includes('\uFFFD'), false);
});

test('project trigger copy and destination use only assigned-project fields', () => {
    const projectId = new mongoose.Types.ObjectId();
    const project = { _id: projectId, title: 'Launch edit', client: 'Acme' };
    assert.deepEqual(buildProjectAssignmentCopy(project), {
        title: 'New Project Assigned',
        body: 'Launch edit for Acme has been assigned to you.'
    });
    assert.equal(getProjectNotificationUrl(project), `/project/${projectId}`);
    assert.equal(getProjectNotificationEventId(project, 'new_project'), `new_project:${projectId}`);
    assert.equal(getProjectNotificationEventId(project, 'revision_needed'), `revision_needed:${projectId}`);
});

test('project submission recipients come from the recorded creator, never a broad role fallback', () => {
    assert.deepEqual(getSubmissionNotificationRecipients({
        createdByEmail: 'creator@example.com',
        createdBy: 'Creator'
    }), ['creator@example.com', 'Creator']);
    assert.deepEqual(getSubmissionNotificationRecipients({}), []);
});

test('project updates cannot redirect the immutable creator notification identity', () => {
    const update = buildProjectUpdate({
        status: 'Under Review',
        createdByUserId: new mongoose.Types.ObjectId(),
        createdByEmail: 'attacker@example.com',
        createdBy: 'Attacker'
    });
    assert.deepEqual(update, { status: 'Under Review' });
});
