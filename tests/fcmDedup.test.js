const test = require('node:test');
const assert = require('node:assert/strict');
const { claimFcmEvent } = require('../fcm');

test('FCM event deduplication permits one alarm per token and stable event ID', () => {
    assert.equal(claimFcmEvent('token-a', 'project:event:one', 1000), true);
    assert.equal(claimFcmEvent('token-a', 'project:event:one', 1001), false);
    assert.equal(claimFcmEvent('token-b', 'project:event:one', 1001), true);
    assert.equal(claimFcmEvent('token-a', 'project:event:two', 1001), true);
});
