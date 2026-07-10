const test = require('node:test');
const assert = require('node:assert/strict');
const { selectRecipientIds } = require('../services/pushRecipients');

test('recipient selection deduplicates devices by user and excludes sender/creator accounts', () => {
    const recipients = [
        { _id: 'recipient-a' },
        { _id: 'recipient-a' },
        { _id: 'recipient-b' },
        { _id: 'creator' }
    ];
    const selected = selectRecipientIds(recipients, [{ _id: 'creator' }, { _id: 'sender' }]);
    assert.deepEqual(selected, ['recipient-a', 'recipient-b']);
});
