const test = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const { buildMessagePush, getSafeMessagePreview } = require('../routes/chat');
const { buildProjectAssignmentCopy, getProjectNotificationUrl } = require('../routes/projects');

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
    assert.deepEqual(notification.excludeReferences.map(String), [senderId.toString(), 'Sender', 'sender@example.com']);
    assert.deepEqual(notification.references, ['Sender', 'Recipient']);
});

test('message preview is bounded and does not expose the full message', () => {
    const longText = 'private '.repeat(30);
    const preview = getSafeMessagePreview(longText, false);
    assert.ok(preview.length <= 81);
    assert.ok(preview.endsWith('…'));
    assert.equal(getSafeMessagePreview('', true), 'Sent an attachment');
});

test('project trigger copy and destination use only assigned-project fields', () => {
    const projectId = new mongoose.Types.ObjectId();
    const project = { _id: projectId, title: 'Launch edit', client: 'Acme' };
    assert.deepEqual(buildProjectAssignmentCopy(project), {
        title: 'New Project Assigned',
        body: 'Launch edit for Acme has been assigned to you.'
    });
    assert.equal(getProjectNotificationUrl(project), `/project/${projectId}`);
});
