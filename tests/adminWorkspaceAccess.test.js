const test = require('node:test');
const assert = require('node:assert/strict');
const { requireEditor } = require('../routes/projectAssignments');
test('mobile workspace accepts Admin and Editor accounts while denying other roles', () => {
    for (const role of [['Admin'], ['Editor'], ['Admin', 'Editor'], ['Marketer'], []]) {
        let permitted = false, status;
        requireEditor({ user: { role } }, { status(value) { status = value; return this; }, json() {} }, () => { permitted = true; });
        assert.equal(permitted, role.includes('Admin') || role.includes('Editor'));
        if (!permitted) assert.equal(status, 403);
    }
});
