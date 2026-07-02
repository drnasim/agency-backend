const mongoose = require('mongoose');
const Employee = require('../models/Employee');
const User = require('../models/User');

const escapeRegExp = (value) => String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const normalizeIdentity = (value) => String(value || '').trim();

const addIdentity = (set, value) => {
    const identity = normalizeIdentity(value);
    if (identity) set.add(identity);
};

const isObjectId = (value) => mongoose.Types.ObjectId.isValid(String(value || ''));

const identityConditions = (fields, value) => {
    const identity = normalizeIdentity(value);
    if (!identity) return [];

    const conditions = [];
    if (isObjectId(identity)) conditions.push({ _id: identity });

    const caseInsensitiveExact = new RegExp(`^${escapeRegExp(identity)}$`, 'i');
    fields.forEach((field) => {
        conditions.push({ [field]: identity });
        conditions.push({ [field]: caseInsensitiveExact });
    });

    return conditions;
};

const findEmployeeByReference = async (reference) => {
    const conditions = identityConditions(['name', 'email'], reference);
    if (!conditions.length) return null;
    return Employee.findOne({ $or: conditions }).lean();
};

const findUserByReference = async (reference) => {
    const conditions = identityConditions(['name', 'email'], reference);
    if (!conditions.length) return null;
    return User.findOne({ $or: conditions }).lean();
};

const collectEmployeeIdentity = (set, employee) => {
    if (!employee) return;
    addIdentity(set, employee._id);
    addIdentity(set, employee.name);
    addIdentity(set, employee.email);
};

const collectUserIdentity = (set, user) => {
    if (!user) return;
    addIdentity(set, user._id);
    addIdentity(set, user.name);
    addIdentity(set, user.email);
};

const resolveNotificationRecipient = async (reference) => {
    const candidates = new Set();
    addIdentity(candidates, reference);

    const [directEmployee, directUser] = await Promise.all([
        findEmployeeByReference(reference),
        findUserByReference(reference)
    ]);

    collectEmployeeIdentity(candidates, directEmployee);
    collectUserIdentity(candidates, directUser);

    let employeeUser = null;
    if (directEmployee) {
        employeeUser = await findUserByReference(directEmployee.email || directEmployee.name);
        collectUserIdentity(candidates, employeeUser);
    }

    return {
        reference: normalizeIdentity(reference),
        employee: directEmployee,
        user: directUser || employeeUser,
        candidates: [...candidates]
    };
};

const resolveNotificationCandidates = async (reference) => {
    const resolved = await resolveNotificationRecipient(reference);
    return resolved.candidates;
};

const resolveNotificationUsers = async (reference, query = {}) => {
    const candidates = await resolveNotificationCandidates(reference);
    if (!candidates.length) return [];

    const conditions = candidates.flatMap((candidate) => identityConditions(['name', 'email'], candidate));
    if (!conditions.length) return [];

    return User.find({ ...query, $or: conditions }).lean();
};

module.exports = {
    resolveNotificationRecipient,
    resolveNotificationCandidates,
    resolveNotificationUsers
};
