const mongoose = require('mongoose');
const Employee = require('../models/Employee');
const User = require('../models/User');
const { pushService } = require('./pushService');

const escapeRegExp = value => String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const activeUserFilter = { isActive: { $ne: false } };

const findUserByEmail = email => User.findOne({
    ...activeUserFilter,
    email: new RegExp(`^${escapeRegExp(String(email || '').trim())}$`, 'i')
}).lean();

const resolveSingleUserReference = async (reference) => {
    const value = String(reference || '').trim();
    if (!value) return null;

    if (mongoose.Types.ObjectId.isValid(value)) {
        const directUser = await User.findOne({ _id: value, ...activeUserFilter }).lean();
        if (directUser) return directUser;
        const employee = await Employee.findById(value).lean();
        return employee?.email ? findUserByEmail(employee.email) : null;
    }

    if (value.includes('@')) return findUserByEmail(value);

    const exactName = new RegExp(`^${escapeRegExp(value)}$`, 'i');
    const employees = await Employee.find({ name: exactName }).limit(2).lean();
    if (employees.length === 1) return findUserByEmail(employees[0].email);
    if (employees.length > 1) {
        console.warn('Skipped an ambiguous browser push employee reference');
        return null;
    }

    const users = await User.find({ ...activeUserFilter, name: exactName }).limit(2).lean();
    if (users.length === 1) return users[0];
    if (users.length > 1) console.warn('Skipped an ambiguous browser push user reference');
    return null;
};

const resolveUsersForReferences = async (references = []) => {
    const groups = await Promise.all([...new Set(
        references.map(value => String(value || '').trim()).filter(Boolean)
    )].map(resolveSingleUserReference));
    const users = new Map();
    groups.filter(Boolean).forEach(user => users.set(user._id.toString(), user));
    return [...users.values()];
};

const selectRecipientIds = (recipients = [], excluded = []) => {
    const excludedIds = new Set(excluded.map(user => user._id.toString()));
    return [...new Set(recipients
        .map(user => user._id.toString())
        .filter(userId => !excludedIds.has(userId)))];
};

const sendPushToReferences = async (references, payload, { eventId, excludeReferences = [] } = {}) => {
    try {
        const [recipients, excluded] = await Promise.all([
            resolveUsersForReferences(references),
            resolveUsersForReferences(excludeReferences)
        ]);
        const recipientIds = selectRecipientIds(recipients, excluded);
        return pushService.sendToUsers(recipientIds, payload, { eventId });
    } catch (error) {
        console.error('Browser push recipient resolution failed:', error.message);
        return [];
    }
};

module.exports = {
    resolveSingleUserReference,
    resolveUsersForReferences,
    selectRecipientIds,
    sendPushToReferences
};
