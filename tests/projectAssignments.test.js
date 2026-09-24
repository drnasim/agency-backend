const test = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');

const Project = require('../models/Project');
const MobileDevice = require('../models/MobileDevice');
const { authenticate, requireAdmin } = require('../middleware/authenticate');
const mobileDeviceRoutes = require('../routes/mobileDevices');
const projectAssignmentRoutes = require('../routes/projectAssignments');
const projectRoutes = require('../routes/projects');
const {
    ACTIVE_PROJECT_STATUSES,
    acceptProjectAssignment,
    acknowledgeProjectAssignmentDelivery,
    buildActiveProjectFilter,
    buildPendingAssignmentFields,
    filterActiveProjectsForUser,
    serializeProjectForApi,
    stripProjectAssignmentLifecycleFields
} = require('../services/projectAssignments');

const sameValue = (left, right) => {
    if (left === null || left === undefined || right === null || right === undefined) {
        return left == null && right == null;
    }
    return String(left) === String(right);
};

const matches = (record, filter) => Object.entries(filter).every(([key, expected]) => (
    sameValue(record[key], expected)
));

const createFakeProjectModel = initial => {
    const model = {
        state: { ...initial },
        updateCalls: [],
        async findOneAndUpdate(filter, update) {
            this.updateCalls.push({ filter, update });
            if (!matches(this.state, filter)) return null;
            const set = Array.isArray(update) ? update[0].$set : update.$set;
            for (const [key, value] of Object.entries(set || {})) {
                if (value && typeof value === 'object' && '$ifNull' in value) {
                    const [fieldReference, fallback] = value.$ifNull;
                    const sourceKey = String(fieldReference).replace(/^\$/, '');
                    this.state[key] = this.state[sourceKey] ?? fallback;
                } else if (value && typeof value === 'object' && '$literal' in value) {
                    this.state[key] = value.$literal;
                } else {
                    this.state[key] = value;
                }
            }
            return this.state;
        },
        async findOne(filter) {
            return matches(this.state, filter) ? this.state : null;
        }
    };
    return model;
};

const findRouteHandler = (router, path, method) => {
    const layer = router.stack.find(candidate => (
        candidate.route?.path === path && candidate.route.methods[method]
    ));
    assert.ok(layer, `Expected ${method.toUpperCase()} ${path} route`);
    return layer.route.stack.at(-1).handle;
};

const createResponseRecorder = () => ({
    statusCode: 200,
    body: null,
    status(code) {
        this.statusCode = code;
        return this;
    },
    json(value) {
        this.body = value;
        return this;
    }
});

test('project assignment fields are server-owned and priority is schema validated', () => {
    const cleaned = stripProjectAssignmentLifecycleFields({
        title: 'Launch edit',
        priority: 'Urgent',
        assignmentStatus: 'accepted',
        assignmentVersion: 99,
        assignedAt: 'forged',
        deliveredAt: 'forged',
        acceptedAt: 'forged',
        assignmentExpiresAt: 'forged',
        acceptedBy: { name: 'Attacker' },
        assignedEditorUserId: new mongoose.Types.ObjectId()
    });
    assert.deepEqual(cleaned, { title: 'Launch edit', priority: 'Urgent' });

    assert.equal(new Project({ title: 'Valid', priority: 'High' }).validateSync(), undefined);
    assert.ok(new Project({ title: 'Invalid', priority: 'Impossible' }).validateSync()?.errors.priority);
});

test('new assignment metadata has a versioned request and a finite ring-only cutoff', () => {
    const editorId = new mongoose.Types.ObjectId();
    const assignedAt = new Date('2026-08-26T17:40:00.000Z');
    const fields = buildPendingAssignmentFields({
        project: { assignmentVersion: 7 },
        assignedEditorUser: { _id: editorId },
        now: assignedAt
    });

    assert.equal(fields.assignmentStatus, 'pending');
    assert.equal(fields.assignmentVersion, 8);
    assert.equal(String(fields.assignedEditorUserId), String(editorId));
    assert.equal(fields.assignedAt, assignedAt);
    assert.ok(fields.assignmentExpiresAt > assignedAt);
    assert.equal(fields.acceptedAt, null);
    assert.equal(fields.deliveredAt, null);
});

test('an editor can accept after the ring timeout and repeated acceptance is idempotent', async () => {
    const editorId = new mongoose.Types.ObjectId();
    const firstAcceptedAt = new Date('2026-08-26T17:42:00.000Z');
    const model = createFakeProjectModel({
        _id: new mongoose.Types.ObjectId(),
        assignmentRequestId: 'request-expired-but-pending',
        assignmentVersion: 3,
        assignedEditorUserId: editorId,
        assignmentStatus: 'pending',
        assignmentExpiresAt: new Date('2026-08-26T17:41:00.000Z'),
        deliveredAt: null,
        acceptedAt: null,
        acceptedBy: { userId: null, name: '' }
    });

    const first = await acceptProjectAssignment({
        ProjectModel: model,
        requestId: 'request-expired-but-pending',
        assignmentVersion: 3,
        user: { _id: editorId, name: 'Editor One', email: 'private@example.com' },
        now: firstAcceptedAt
    });
    assert.equal(first.alreadyAccepted, false);
    assert.equal(first.project.assignmentStatus, 'accepted');
    assert.equal(first.project.acceptedAt, firstAcceptedAt);
    assert.equal(first.project.deliveredAt, firstAcceptedAt);
    assert.deepEqual(first.project.acceptedBy, { userId: editorId, name: 'Editor One' });
    assert.equal('assignmentExpiresAt' in model.updateCalls[0].filter, false);

    const second = await acceptProjectAssignment({
        ProjectModel: model,
        requestId: 'request-expired-but-pending',
        assignmentVersion: 3,
        user: { _id: editorId, name: 'Editor One' },
        now: new Date('2026-08-26T17:45:00.000Z')
    });
    assert.equal(second.alreadyAccepted, true);
    assert.equal(second.project.acceptedAt, firstAcceptedAt);
});

test('stale or reassigned assignment requests cannot be accepted', async () => {
    const editorId = new mongoose.Types.ObjectId();
    const model = createFakeProjectModel({
        assignmentRequestId: 'new-request',
        assignmentVersion: 5,
        assignedEditorUserId: editorId,
        assignmentStatus: 'pending'
    });

    await assert.rejects(
        acceptProjectAssignment({
            ProjectModel: model,
            requestId: 'old-request',
            assignmentVersion: 4,
            user: { _id: editorId, name: 'Editor' }
        }),
        error => error.statusCode === 409 && error.code === 'ASSIGNMENT_NO_LONGER_PENDING'
    );
    assert.equal(model.state.assignmentStatus, 'pending');

    await assert.rejects(
        acceptProjectAssignment({
            ProjectModel: model,
            requestId: 'new-request',
            assignmentVersion: 4,
            user: { _id: editorId, name: 'Editor' }
        }),
        error => error.statusCode === 409
    );
});

test('delivery acknowledgement records the earliest real-device timestamp only', async () => {
    const editorId = new mongoose.Types.ObjectId();
    const firstDeliveredAt = new Date('2026-08-26T17:40:05.000Z');
    const model = createFakeProjectModel({
        assignmentRequestId: 'delivery-request',
        assignedEditorUserId: editorId,
        assignmentStatus: 'pending',
        deliveredAt: null
    });

    const first = await acknowledgeProjectAssignmentDelivery({
        ProjectModel: model,
        requestId: 'delivery-request',
        userId: editorId,
        now: firstDeliveredAt
    });
    const second = await acknowledgeProjectAssignmentDelivery({
        ProjectModel: model,
        requestId: 'delivery-request',
        userId: editorId,
        now: new Date('2026-08-26T17:40:20.000Z')
    });

    assert.equal(first.newlyDelivered, true);
    assert.equal(second.newlyDelivered, false);
    assert.equal(model.state.deliveredAt, firstDeliveredAt);
});

test('reassignment sends an old-request stop followed by a new-request start', () => {
    const oldEditorId = new mongoose.Types.ObjectId();
    const newEditorId = new mongoose.Types.ObjectId();
    const oldProject = {
        _id: 'project-1',
        assignmentRequestId: 'old-request',
        assignmentVersion: 2
    };
    const updatedProject = {
        _id: 'project-1',
        assignmentRequestId: 'new-request',
        assignmentVersion: 3
    };
    const deliveries = projectRoutes.buildAssignmentTransitionDeliveries({
        oldProject,
        updatedProject,
        transition: {
            changed: true,
            reason: 'reassigned',
            oldRecipientUser: { _id: oldEditorId },
            newRecipientUser: { _id: newEditorId }
        }
    });

    assert.equal(deliveries.length, 2);
    assert.equal(deliveries[0].action, 'reassigned');
    assert.equal(deliveries[0].project.assignmentRequestId, 'old-request');
    assert.deepEqual(deliveries[0].recipientUserIds, [oldEditorId]);
    assert.equal(deliveries[1].action, 'assigned');
    assert.equal(deliveries[1].project.assignmentRequestId, 'new-request');
    assert.deepEqual(deliveries[1].recipientUserIds, [newEditorId]);
});

test('unassigning, completing or deleting a pending project targets the old request for cancellation', () => {
    const editorId = new mongoose.Types.ObjectId();
    const oldProject = {
        _id: 'project-1',
        assignmentRequestId: 'still-ringing-request',
        assignmentVersion: 6
    };
    for (const reason of ['unassigned', 'project_terminal', 'project_deleted']) {
        const [delivery] = projectRoutes.buildAssignmentTransitionDeliveries({
            oldProject,
            updatedProject: { _id: 'project-1', assignmentRequestId: null, assignmentVersion: 7 },
            transition: {
                changed: true,
                reason,
                oldRecipientUser: { _id: editorId },
                newRecipientUser: null
            }
        });
        assert.equal(delivery.action, 'cancelled');
        assert.equal(delivery.project.assignmentRequestId, 'still-ringing-request');
        assert.equal(delivery.project.assignmentVersion, 6);
    }
});

test('changing a terminal project editor never creates a new pending request', async () => {
    const oldProject = {
        _id: 'completed-project',
        status: 'Completed',
        assignedEditor: 'Editor One',
        editor: 'Editor One',
        assignmentStatus: 'accepted',
        assignmentRequestId: 'accepted-request',
        assignmentVersion: 3
    };
    const update = { assignedEditor: 'Editor Two' };

    const transition = await projectRoutes.prepareProjectAssignmentTransition(oldProject, update);

    assert.equal(transition.changed, false);
    assert.equal(transition.terminal, true);
    assert.equal(update.assignedEditor, 'Editor Two');
    assert.equal(update.editor, 'Editor Two');
    assert.equal(Object.hasOwn(update, 'assignmentStatus'), false);
    assert.equal(Object.hasOwn(update, 'assignmentRequestId'), false);
    assert.equal(Object.hasOwn(update, 'assignmentVersion'), false);
});

test('public project serialization omits accepted editor email snapshots', () => {
    const serialized = serializeProjectForApi({
        _id: 'project-1',
        acceptedBy: {
            userId: 'editor-1',
            name: 'Editor One',
            email: 'private@example.com'
        }
    });
    assert.deepEqual(serialized.acceptedBy, { userId: 'editor-1', name: 'Editor One' });
    assert.equal(JSON.stringify(serialized).includes('private@example.com'), false);
});

test('project creation route enforces Admin access before its mutation handler', () => {
    const layer = projectRoutes.stack.find(candidate => candidate.route?.path === '/' && candidate.route.methods.post);
    assert.ok(layer);
    assert.equal(layer.route.stack.length, 3);
    assert.equal(layer.route.stack[1].handle, requireAdmin);
});

test('project writes use object filters and lifecycle transitions compare assignment versions', () => {
    assert.deepEqual(projectRoutes.getProjectUpdateFilter('project-1', {}, false), { _id: 'project-1' });
    assert.deepEqual(
        projectRoutes.getProjectUpdateFilter('project-1', { assignmentVersion: 4, assignmentStatus: 'pending' }, true),
        { _id: 'project-1', assignmentVersion: 4, assignmentStatus: 'pending' }
    );
});

test('active project sync is scoped to the authenticated editor and nonterminal workflow statuses', async () => {
    const handler = findRouteHandler(projectAssignmentRoutes, '/active', 'get');
    const realFind = Project.find;
    const authenticatedUserId = new mongoose.Types.ObjectId();
    let capturedFilter;
    let capturedSort;
    Project.find = filter => {
        capturedFilter = filter;
        return {
            sort(sort) {
                capturedSort = sort;
                return this;
            },
            async lean() {
                return [{
                    _id: 'project-1',
                    assignedEditorUserId: authenticatedUserId,
                    title: 'Launch video',
                    client: 'Acme',
                    status: 'In Progress',
                    acceptedBy: {
                        userId: 'editor-1',
                        name: 'Editor One',
                        email: 'private@example.com'
                    }
                }];
            }
        };
    };

    try {
        const res = createResponseRecorder();
        await handler({
            user: {
                _id: authenticatedUserId,
                name: 'Editor One',
                email: 'editor.one@example.com'
            }
        }, res);

        assert.equal(res.statusCode, 200);
        assert.equal(String(capturedFilter.$or[0].assignedEditorUserId), String(authenticatedUserId));
        assert.equal(capturedFilter.$or[1].assignedEditorUserId, null);
        assert.deepEqual(
            capturedFilter.$or[1].$or.map(clause => Object.keys(clause)[0]),
            ['assignedEditor', 'editor', 'assignedTo']
        );
        assert.deepEqual(capturedFilter.status, { $in: ACTIVE_PROJECT_STATUSES });
        assert.deepEqual(capturedSort, { deadline: 1, updatedAt: -1 });
        assert.equal(res.body.projects.length, 1);
        assert.equal(res.body.projects[0].projectUrl, '/project/project-1');
        assert.deepEqual(res.body.projects[0].acceptedBy, {
            userId: 'editor-1',
            name: 'Editor One'
        });
        assert.equal(JSON.stringify(res.body).includes('private@example.com'), false);
        assert.ok(Number.isFinite(new Date(res.body.serverTime).getTime()));
    } finally {
        Project.find = realFind;
    }
});

test('editor project details are ownership-scoped and enrich the project with exact-client guidelines', async () => {
    const editorId = new mongoose.Types.ObjectId();
    const projectId = new mongoose.Types.ObjectId();
    const now = new Date('2026-08-30T08:15:00.000Z');
    let capturedProjectFilter;
    let capturedClientFilter;
    let capturedClientProjection;
    const handler = projectAssignmentRoutes.createProjectDetailsHandler({
        ProjectModel: {
            findOne(filter) {
                capturedProjectFilter = filter;
                return {
                    async lean() {
                        return {
                            _id: projectId,
                            assignedEditorUserId: editorId,
                            assignmentStatus: 'pending',
                            title: 'Fortivus launch film',
                            client: 'Acme Studios',
                            status: 'In Progress',
                            acceptedBy: {
                                userId: editorId,
                                name: 'Editor One',
                                email: 'private@example.com'
                            }
                        };
                    }
                };
            }
        },
        ClientModel: {
            findOne(filter, projection) {
                capturedClientFilter = filter;
                capturedClientProjection = projection;
                return {
                    async lean() {
                        return {
                            guidelineItems: [
                                {
                                    category: 'Audio',
                                    instruction: 'Avoid clipped dialogue',
                                    ruleType: 'Avoid'
                                },
                                {
                                    category: 'Brand',
                                    instruction: 'Use the supplied logo lockup',
                                    ruleType: 'Must Use'
                                }
                            ],
                            guidelineNotes: 'Hold the end frame for two seconds.'
                        };
                    }
                };
            }
        },
        getNow: () => now
    });

    const res = createResponseRecorder();
    await handler({
        params: { projectId: projectId.toString() },
        user: {
            _id: editorId,
            name: 'Editor One',
            email: 'editor.one@example.com'
        }
    }, res);

    assert.equal(res.statusCode, 200);
    assert.equal(String(capturedProjectFilter._id), projectId.toString());
    assert.equal(String(capturedProjectFilter.$or[0].assignedEditorUserId), editorId.toString());
    assert.deepEqual(capturedProjectFilter.status, { $in: ACTIVE_PROJECT_STATUSES });
    assert.deepEqual(capturedClientFilter, { name: 'Acme Studios' });
    assert.deepEqual(capturedClientProjection, {
        guidelines: 1,
        guidelineItems: 1,
        guidelineNotes: 1,
        _id: 0
    });
    assert.equal(res.body.serverTime, now.toISOString());
    assert.equal(res.body.project.projectUrl, `/project/${projectId}`);
    assert.deepEqual(res.body.project.acceptedBy, {
        userId: editorId.toString(),
        name: 'Editor One'
    });
    assert.equal(res.body.project.clientGuidelineProfile.items[0].ruleType, 'Must Use');
    assert.match(res.body.project.clientGuidelines, /Use the supplied logo lockup/);
    assert.match(res.body.project.clientGuidelines, /Hold the end frame for two seconds/);
    assert.equal(JSON.stringify(res.body).includes('private@example.com'), false);
});

test('editor project details conceal invalid, inactive or other-editor projects before guideline lookup', async () => {
    const editorId = new mongoose.Types.ObjectId();
    const otherEditorId = new mongoose.Types.ObjectId();
    const projectId = new mongoose.Types.ObjectId();
    let projectQueries = 0;
    let clientQueries = 0;
    const handler = projectAssignmentRoutes.createProjectDetailsHandler({
        ProjectModel: {
            findOne() {
                projectQueries += 1;
                return {
                    async lean() {
                        return {
                            _id: projectId,
                            assignedEditorUserId: otherEditorId,
                            client: 'Private Client',
                            status: 'In Progress'
                        };
                    }
                };
            }
        },
        ClientModel: {
            findOne() {
                clientQueries += 1;
                return { async lean() { return null; } };
            }
        }
    });

    const invalidRes = createResponseRecorder();
    await handler({
        params: { projectId: 'not-a-valid-project-id' },
        user: { _id: editorId }
    }, invalidRes);
    assert.equal(invalidRes.statusCode, 404);
    assert.deepEqual(invalidRes.body, { error: 'Project is unavailable' });
    assert.equal(projectQueries, 0);

    const otherEditorRes = createResponseRecorder();
    await handler({
        params: { projectId: projectId.toString() },
        user: { _id: editorId }
    }, otherEditorRes);
    assert.equal(otherEditorRes.statusCode, 404);
    assert.deepEqual(otherEditorRes.body, { error: 'Project is unavailable' });
    assert.equal(projectQueries, 1);
    assert.equal(clientQueries, 0);
});

test('editor detail route is registered before assignment request action routes', () => {
    const detailsIndex = projectAssignmentRoutes.stack.findIndex(candidate => (
        candidate.route?.path === '/:projectId/details' && candidate.route.methods.get
    ));
    const deliveryIndex = projectAssignmentRoutes.stack.findIndex(candidate => (
        candidate.route?.path === '/:requestId/delivered' && candidate.route.methods.post
    ));
    assert.ok(detailsIndex >= 0);
    assert.ok(deliveryIndex > detailsIndex);
});

test('legacy active projects are exact-match candidates and are verified against the authenticated editor', async () => {
    const authenticatedUserId = new mongoose.Types.ObjectId();
    const otherUserId = new mongoose.Types.ObjectId();
    const user = {
        _id: authenticatedUserId,
        name: 'Editor.One',
        email: 'editor.one@example.com'
    };
    const filter = buildActiveProjectFilter(user);
    const legacyMatch = filter.$or[1];
    const assignedEditorMatchers = legacyMatch.$or[0].assignedEditor.$in;

    assert.ok(assignedEditorMatchers.some(matcher => matcher.test('EDITOR.ONE@EXAMPLE.COM')));
    assert.ok(assignedEditorMatchers.some(matcher => matcher.test(' Editor.One ')));
    assert.equal(assignedEditorMatchers.some(matcher => matcher.test('Editor.One Attacker')), false);
    assert.deepEqual(filter.status, { $in: ACTIVE_PROJECT_STATUSES });

    const projects = [
        { _id: 'immutable-owned', assignedEditorUserId: authenticatedUserId },
        { _id: 'immutable-other', assignedEditorUserId: otherUserId },
        { _id: 'legacy-owned', assignedEditorUserId: null, assignedEditor: 'Editor.One' },
        { _id: 'legacy-other', editor: 'Other Editor' },
        { _id: 'legacy-ambiguous', assignedEditor: 'Shared Name' }
    ];
    const resolveLegacyOwner = async project => {
        if (project._id === 'legacy-owned') return { _id: authenticatedUserId };
        if (project._id === 'legacy-other') return { _id: otherUserId };
        // Ambiguous legacy names deliberately resolve to no user.
        return null;
    };

    const visible = await filterActiveProjectsForUser(projects, user, resolveLegacyOwner);
    assert.deepEqual(visible.map(project => project._id), ['immutable-owned', 'legacy-owned']);
});

test('device registration binds a token to the authenticated user, never a supplied user id', async () => {
    const handler = findRouteHandler(mobileDeviceRoutes, '/:installationId', 'put');
    const realFindOneAndUpdate = MobileDevice.findOneAndUpdate;
    const realDeleteMany = MobileDevice.deleteMany;
    const authenticatedUserId = new mongoose.Types.ObjectId();
    const attackerUserId = new mongoose.Types.ObjectId();
    let capturedUpdate;
    MobileDevice.deleteMany = async () => ({ deletedCount: 0 });
    MobileDevice.findOneAndUpdate = async (_filter, update) => {
        capturedUpdate = update;
        return update.$set;
    };

    try {
        const res = createResponseRecorder();
        await handler({
            params: { installationId: 'installation-12345' },
            body: {
                fcmToken: 'fcm-token-that-is-long-enough-12345',
                userId: attackerUserId
            },
            user: { _id: authenticatedUserId }
        }, res);

        assert.equal(res.statusCode, 200);
        assert.equal(String(capturedUpdate.$set.userId), String(authenticatedUserId));
        assert.notEqual(String(capturedUpdate.$set.userId), String(attackerUserId));
    } finally {
        MobileDevice.findOneAndUpdate = realFindOneAndUpdate;
        MobileDevice.deleteMany = realDeleteMany;
    }
});

test('delivery acknowledgements reject installations not registered to the editor', async () => {
    const handler = findRouteHandler(projectAssignmentRoutes, '/:requestId/delivered', 'post');
    const realExists = MobileDevice.exists;
    const realFindOneAndUpdate = Project.findOneAndUpdate;
    let projectWriteAttempted = false;
    MobileDevice.exists = async () => null;
    Project.findOneAndUpdate = async () => {
        projectWriteAttempted = true;
        return null;
    };

    try {
        const res = createResponseRecorder();
        await handler({
            params: { requestId: 'request-1' },
            body: { installationId: 'installation-12345' },
            user: { _id: new mongoose.Types.ObjectId() }
        }, res);
        assert.equal(res.statusCode, 403);
        assert.equal(projectWriteAttempted, false);
    } finally {
        MobileDevice.exists = realExists;
        Project.findOneAndUpdate = realFindOneAndUpdate;
    }
});

test('mobile accept-project is an authenticated Editor route with the queue-safe body contract', () => {
    const routeIndex = mobileDeviceRoutes.stack.findIndex(candidate => (
        candidate.route?.path === '/accept-project' && candidate.route.methods.post
    ));
    const layer = mobileDeviceRoutes.stack[routeIndex];
    const authenticationIndex = mobileDeviceRoutes.stack.findIndex(candidate => (
        candidate.handle === authenticate
    ));
    assert.ok(layer);
    assert.ok(authenticationIndex >= 0 && authenticationIndex < routeIndex);
    assert.equal(layer.route.stack.length, 2);
    assert.equal(layer.route.stack[0].handle, mobileDeviceRoutes.requireEditor);
});

test('mobile accept-project validates its installation and returns a stable accepted response', async () => {
    const editorId = new mongoose.Types.ObjectId();
    const now = new Date('2026-08-28T06:30:00.000Z');
    const project = {
        _id: 'project-1',
        title: 'Launch video',
        assignmentStatus: 'accepted',
        assignmentRequestId: 'request-1',
        assignmentVersion: 4,
        acceptedAt: now,
        acceptedBy: { userId: editorId, name: 'Editor One', email: 'private@example.com' }
    };
    const calls = { exists: [], heartbeat: [], accept: [], publish: [] };
    const ProjectModel = { name: 'injected project model' };
    const MobileDeviceModel = {
        async exists(filter) {
            calls.exists.push(filter);
            return { _id: 'device-record' };
        },
        async updateOne(filter, update) {
            calls.heartbeat.push({ filter, update });
            return { matchedCount: 1 };
        }
    };
    const handler = mobileDeviceRoutes.createAcceptProjectHandler({
        ProjectModel,
        MobileDeviceModel,
        getNow: () => now,
        acceptAssignment: async options => {
            calls.accept.push(options);
            return { project, alreadyAccepted: false };
        },
        publishEvent: async options => {
            calls.publish.push(options);
            return { mobileResults: [{ delivered: true }] };
        }
    });

    const res = createResponseRecorder();
    await handler({
        body: {
            assignmentRequestId: 'request-1',
            assignmentVersion: 4,
            installationId: 'installation-12345'
        },
        user: { _id: editorId, name: 'Editor One', role: ['Editor'] }
    }, res);

    assert.equal(res.statusCode, 200);
    assert.equal(calls.accept[0].ProjectModel, ProjectModel);
    assert.equal(calls.accept[0].requestId, 'request-1');
    assert.equal(calls.accept[0].assignmentVersion, 4);
    assert.equal(calls.accept[0].now, now);
    assert.deepEqual(calls.exists[0], {
        userId: editorId,
        installationId: 'installation-12345',
        enabled: true
    });
    assert.deepEqual(calls.heartbeat[0].update, { $set: { lastSeenAt: now } });
    assert.equal(calls.publish.length, 1);
    assert.equal(calls.publish[0].action, 'accepted');
    assert.equal(calls.publish[0].sendMobile, true);
    assert.deepEqual(res.body, {
        assignmentStatus: 'accepted',
        assignmentRequestId: 'request-1',
        assignmentVersion: 4,
        acceptedAt: now,
        acceptedBy: { userId: editorId.toString(), name: 'Editor One' },
        project: {
            ...project,
            acceptedBy: { userId: editorId.toString(), name: 'Editor One' }
        },
        projectUrl: '/project/project-1',
        alreadyAccepted: false
    });
    assert.equal(JSON.stringify(res.body).includes('private@example.com'), false);
});

test('mobile accept-project retries are idempotent and do not republish acceptance', async () => {
    const editorId = new mongoose.Types.ObjectId();
    let publishCount = 0;
    const handler = mobileDeviceRoutes.createAcceptProjectHandler({
        acceptAssignment: async () => ({
            alreadyAccepted: true,
            project: {
                _id: 'project-1',
                assignmentStatus: 'accepted',
                acceptedAt: new Date('2026-08-28T06:30:00.000Z'),
                acceptedBy: { userId: editorId, name: 'Editor One' }
            }
        }),
        publishEvent: async () => { publishCount += 1; }
    });

    const res = createResponseRecorder();
    await handler({
        body: { assignmentRequestId: 'request-1', assignmentVersion: 4 },
        user: { _id: editorId, name: 'Editor One', role: ['Editor'] }
    }, res);

    assert.equal(res.statusCode, 200);
    assert.equal(res.body.alreadyAccepted, true);
    assert.equal(publishCount, 0);
});

test('mobile accept-project rejects an installation not owned by the editor before mutation', async () => {
    let acceptAttempted = false;
    const handler = mobileDeviceRoutes.createAcceptProjectHandler({
        MobileDeviceModel: {
            async exists() { return null; }
        },
        acceptAssignment: async () => {
            acceptAttempted = true;
            throw new Error('must not be reached');
        }
    });

    const res = createResponseRecorder();
    await handler({
        body: {
            assignmentRequestId: 'request-1',
            assignmentVersion: 4,
            installationId: 'installation-12345'
        },
        user: { _id: new mongoose.Types.ObjectId(), role: ['Editor'] }
    }, res);

    assert.equal(res.statusCode, 403);
    assert.equal(acceptAttempted, false);
});

test('mobile accept-project preserves stale assignment conflict semantics for queue retries', async () => {
    const conflict = new Error('This assignment is no longer waiting for acceptance');
    conflict.statusCode = 409;
    conflict.code = 'ASSIGNMENT_NO_LONGER_PENDING';
    const handler = mobileDeviceRoutes.createAcceptProjectHandler({
        acceptAssignment: async () => { throw conflict; },
        logger: { error() {} }
    });

    const res = createResponseRecorder();
    await handler({
        body: { assignmentRequestId: 'stale-request', assignmentVersion: 2 },
        user: { _id: new mongoose.Types.ObjectId(), role: ['Editor'] }
    }, res);

    assert.equal(res.statusCode, 409);
    assert.deepEqual(res.body, {
        error: conflict.message,
        code: 'ASSIGNMENT_NO_LONGER_PENDING'
    });
});
