const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const jwt = require('jsonwebtoken');
const Client = require('../models/Client');
const Project = require('../models/Project');
const Settings = require('../models/Settings');
const User = require('../models/User');
const clientRoutes = require('../routes/clients');
const projectRoutes = require('../routes/projects');
const {
    resolveClientGuidelineData,
    resolveClientGuidelines
} = projectRoutes;
const {
    buildClientWritePayload,
    buildLegacyGuidelines,
    prioritizeMustUseGuidelines
} = require('../utils/clientGuidelines');

const installClientRouteTestAuth = (role = ['Admin'], customCategories = []) => {
    const originalFindUser = User.findOne;
    const originalFindSettings = Settings.findOne;
    const originalJwtSecret = process.env.JWT_SECRET;
    process.env.JWT_SECRET = 'client-guidelines-route-test-secret';

    User.findOne = filter => ({
        select: async () => ({
            _id: filter._id,
            name: 'Test User',
            email: 'test@example.com',
            role,
            isActive: true
        })
    });
    Settings.findOne = () => ({
        lean: async () => ({
            type: 'guidelineCategories',
            payments: customCategories
        })
    });

    return {
        token: jwt.sign({ sub: 'test-user-id' }, process.env.JWT_SECRET),
        restore() {
            User.findOne = originalFindUser;
            Settings.findOne = originalFindSettings;
            if (originalJwtSecret === undefined) delete process.env.JWT_SECRET;
            else process.env.JWT_SECRET = originalJwtSecret;
        }
    };
};

test('client schema stores reusable guidelines as optional plain text', () => {
    const guidelinesPath = Client.schema.path('guidelines');

    assert.equal(guidelinesPath.instance, 'String');
    assert.equal(guidelinesPath.defaultValue, '');
});

test('client schema validates and normalizes structured guideline items', async () => {
    const client = new Client({
        name: 'Acme Studio',
        guidelineItems: [{
            category: '  Font  ',
            instruction: '  Use Inter SemiBold.  ',
            ruleType: 'Must Use',
            referenceType: 'image',
            referenceUrl: '',
            referenceName: 'unused.png'
        }]
    });

    await client.validate();

    assert.equal(client.guidelineItems.length, 1);
    assert.ok(client.guidelineItems[0]._id);
    assert.equal(client.guidelineItems[0].category, 'Font');
    assert.equal(client.guidelineItems[0].instruction, 'Use Inter SemiBold.');
    assert.equal(client.guidelineItems[0].ruleType, 'Must Use');
    assert.equal(client.guidelineItems[0].referenceType, '');
    assert.equal(client.guidelineItems[0].referenceUrl, '');
    assert.equal(client.guidelineItems[0].referenceName, '');
    assert.equal(client.guidelineNotes, '');
});

test('client schema rejects incomplete rules, invalid enums, and unsafe reference URLs', async () => {
    const client = new Client({
        name: 'Acme Studio',
        guidelineItems: [{
            category: ' ',
            instruction: '',
            ruleType: 'Sometimes',
            referenceType: 'document',
            referenceUrl: 'javascript:alert(1)'
        }]
    });

    await assert.rejects(
        client.validate(),
        error => Boolean(
            error.name === 'ValidationError' &&
            error.errors['guidelineItems.0.category'] &&
            error.errors['guidelineItems.0.instruction'] &&
            error.errors['guidelineItems.0.ruleType'] &&
            error.errors['guidelineItems.0.referenceType'] &&
            error.errors['guidelineItems.0.referenceUrl']
        )
    );
});

test('structured rules produce a readable legacy string in project priority order', () => {
    const items = [
        { category: 'Audio', instruction: 'No clipping.', ruleType: 'Avoid' },
        { category: 'Font', instruction: 'Use Inter.', ruleType: 'Must Use' },
        { category: 'Caption', instruction: 'Use sentence case.', ruleType: 'Prefer' },
        { category: 'Color', instruction: 'Use brand blue.', ruleType: 'Must Use' }
    ];

    assert.deepEqual(
        prioritizeMustUseGuidelines(items).map(item => item.category),
        ['Font', 'Color', 'Caption', 'Audio']
    );
    assert.equal(
        buildLegacyGuidelines(items, 'Keep the edit polished.'),
        [
            '[Must Use] Font: Use Inter.',
            '[Must Use] Color: Use brand blue.',
            '[Prefer] Caption: Use sentence case.',
            '[Avoid] Audio: No clipping.',
            'Additional Notes:\nKeep the edit polished.'
        ].join('\n\n')
    );
});

test('client writes synchronize structured fields into the legacy text field', () => {
    const payload = buildClientWritePayload({
        guidelineItems: [{
            category: 'Font',
            instruction: 'Use Inter.',
            ruleType: 'Must Use',
            referenceType: 'link',
            referenceUrl: 'https://example.com/brand',
            referenceName: 'Brand guide'
        }],
        guidelineNotes: 'Deliver at 24 fps.'
    });

    assert.equal(
        payload.guidelines,
        [
            '[Must Use] Font: Use Inter.\nReference (Brand guide): https://example.com/brand',
            'Additional Notes:\nDeliver at 24 fps.'
        ].join('\n\n')
    );
});

test('first structured update migrates legacy-only guidelines when notes are omitted', () => {
    const payload = buildClientWritePayload(
        {
            guidelineItems: [{
                category: 'Color',
                instruction: 'Use brand blue.',
                ruleType: 'Prefer'
            }]
        },
        {
            guidelines: 'Legacy notes must not be lost.',
            guidelineItems: [],
            guidelineNotes: ''
        }
    );

    assert.equal(payload.guidelineNotes, 'Legacy notes must not be lost.');
    assert.match(payload.guidelines, /Legacy notes must not be lost\./);
    assert.match(payload.guidelines, /\[Prefer\] Color: Use brand blue\./);
});

test('legacy clients can still update without replacing their plain-text guidelines', () => {
    const payload = buildClientWritePayload({
        name: 'Renamed Client',
        guidelines: 'Keep this exact legacy text.'
    });

    assert.equal(payload.name, 'Renamed Client');
    assert.equal(payload.guidelines, 'Keep this exact legacy text.');
    assert.equal(Object.hasOwn(payload, 'guidelineItems'), false);
});

test('structured client data overrides stale legacy text on old-UI updates', async () => {
    const existingClient = {
        guidelines: 'Stale legacy copy.',
        guidelineItems: [{
            _id: 'font-rule',
            category: 'Font',
            instruction: 'Use Inter.',
            ruleType: 'Must Use'
        }],
        guidelineNotes: 'Keep this current note.'
    };
    const settingsModel = {
        findOne() {
            return {
                lean: async () => ({ type: 'guidelineCategories', payments: [] })
            };
        }
    };

    const payload = await clientRoutes.prepareClientWritePayload(
        {
            company: 'Updated Company',
            guidelines: 'An old page tried to replace the compatibility text.'
        },
        existingClient,
        settingsModel
    );

    assert.equal(payload.company, 'Updated Company');
    assert.equal(
        payload.guidelines,
        '[Must Use] Font: Use Inter.\n\nAdditional Notes:\nKeep this current note.'
    );
    assert.doesNotMatch(payload.guidelines, /old page|Stale legacy/);
});

test('structured client writes canonicalize known categories and reject stale names', async () => {
    const settingsModel = {
        findOne() {
            return {
                lean: async () => ({
                    type: 'guidelineCategories',
                    payments: ['Brand Voice']
                })
            };
        }
    };

    const payload = await clientRoutes.prepareClientWritePayload(
        {
            guidelineItems: [{
                category: '  brand   voice ',
                instruction: 'Keep it conversational.',
                ruleType: 'Prefer'
            }]
        },
        null,
        settingsModel
    );
    assert.equal(payload.guidelineItems[0].category, 'Brand Voice');
    assert.match(payload.guidelines, /\[Prefer\] Brand Voice:/);

    await assert.rejects(
        clientRoutes.prepareClientWritePayload(
            {
                guidelineItems: [{
                    category: 'Deleted Category',
                    instruction: 'This stale rule must fail.',
                    ruleType: 'Avoid'
                }]
            },
            null,
            settingsModel
        ),
        error => error.statusCode === 400 && /Unknown guideline category/.test(error.message)
    );
});

test('all client mutations reject anonymous and non-Admin callers', async () => {
    const auth = installClientRouteTestAuth(['Editor']);
    const app = express();
    app.use(express.json());
    app.use('/api/clients', clientRoutes);
    const server = await new Promise(resolve => {
        const listeningServer = app.listen(0, '127.0.0.1', () => resolve(listeningServer));
    });

    try {
        const { port } = server.address();
        const baseUrl = `http://127.0.0.1:${port}/api/clients`;
        const requests = [
            { method: 'POST', url: baseUrl },
            { method: 'PUT', url: `${baseUrl}/client-1` },
            { method: 'DELETE', url: `${baseUrl}/client-1` }
        ];

        for (const request of requests) {
            const anonymousResponse = await fetch(request.url, {
                method: request.method,
                headers: { 'content-type': 'application/json' },
                body: request.method === 'DELETE' ? undefined : '{}'
            });
            assert.equal(anonymousResponse.status, 401);

            const editorResponse = await fetch(request.url, {
                method: request.method,
                headers: {
                    authorization: `Bearer ${auth.token}`,
                    'content-type': 'application/json'
                },
                body: request.method === 'DELETE' ? undefined : '{}'
            });
            assert.equal(editorResponse.status, 403);
        }
    } finally {
        auth.restore();
        await new Promise((resolve, reject) => {
            server.close(error => error ? reject(error) : resolve());
        });
    }
});

test('invalid structured client POST returns 400 through the real route', async () => {
    const auth = installClientRouteTestAuth();
    const app = express();
    app.use(express.json());
    app.use('/api/clients', clientRoutes);

    const server = await new Promise(resolve => {
        const listeningServer = app.listen(0, '127.0.0.1', () => resolve(listeningServer));
    });

    try {
        const { port } = server.address();
        const response = await fetch(`http://127.0.0.1:${port}/api/clients`, {
            method: 'POST',
            headers: {
                authorization: `Bearer ${auth.token}`,
                'content-type': 'application/json'
            },
            body: JSON.stringify({
                name: 'Acme Studio',
                guidelineItems: [{ category: 'Font', instruction: '' }]
            })
        });
        const body = await response.json();

        assert.equal(response.status, 400);
        assert.match(body.error, /Guideline instruction is required/);
    } finally {
        auth.restore();
        await new Promise((resolve, reject) => {
            server.close(error => error ? reject(error) : resolve());
        });
    }
});

test('client PUT merges omitted structured fields and enables update validators', async () => {
    const auth = installClientRouteTestAuth();
    const originalFindById = Client.findById;
    const originalFindByIdAndUpdate = Client.findByIdAndUpdate;
    let updateCall = null;

    Client.findById = async () => ({
        guidelineItems: [],
        guidelineNotes: 'Keep the existing notes.',
        guidelines: ''
    });
    Client.findByIdAndUpdate = async (id, payload, options) => {
        updateCall = { id, payload, options };
        return { _id: id, ...payload };
    };

    const app = express();
    app.use(express.json());
    app.use('/api/clients', clientRoutes);
    const server = await new Promise(resolve => {
        const listeningServer = app.listen(0, '127.0.0.1', () => resolve(listeningServer));
    });

    try {
        const { port } = server.address();
        const response = await fetch(`http://127.0.0.1:${port}/api/clients/client-1`, {
            method: 'PUT',
            headers: {
                authorization: `Bearer ${auth.token}`,
                'content-type': 'application/json'
            },
            body: JSON.stringify({
                guidelineItems: [{
                    category: 'Font',
                    instruction: 'Use Inter.',
                    ruleType: 'Must Use'
                }]
            })
        });

        assert.equal(response.status, 200);
        assert.equal(updateCall.id, 'client-1');
        assert.equal(updateCall.options.new, true);
        assert.equal(updateCall.options.runValidators, true);
        assert.match(updateCall.payload.guidelines, /Keep the existing notes\./);
    } finally {
        auth.restore();
        Client.findById = originalFindById;
        Client.findByIdAndUpdate = originalFindByIdAndUpdate;
        await new Promise((resolve, reject) => {
            server.close(error => error ? reject(error) : resolve());
        });
    }
});

test('project details resolve guidelines by the existing client name', async () => {
    const findCalls = [];
    const clientModel = {
        findOne(filter, projection) {
            findCalls.push({ filter, projection });
            return {
                lean: async () => ({
                    guidelines: 'Use Inter SemiBold for every title.\nKeep captions white.'
                })
            };
        }
    };

    const guidelines = await resolveClientGuidelines('Acme Studio', clientModel);

    assert.equal(
        guidelines,
        'Use Inter SemiBold for every title.\nKeep captions white.'
    );
    assert.deepEqual(findCalls, [{
        filter: { name: 'Acme Studio' },
        projection: { guidelines: 1, _id: 0 }
    }]);
});

test('project details endpoint adds resolved client guidelines without changing project fields', async () => {
    const originalFindProjectById = Project.findById;
    const originalFindClient = Client.findOne;
    const app = express();
    app.use('/api/projects', projectRoutes);

    Project.findById = () => ({
        lean: async () => ({
            _id: 'project-1',
            title: 'Launch Video',
            client: 'Acme Studio',
            assignedEditor: 'Editor One',
            status: 'Pending'
        })
    });
    Client.findOne = () => ({
        lean: async () => ({
            guidelines: 'Use Inter SemiBold.\nKeep captions white.'
        })
    });

    const server = await new Promise(resolve => {
        const listeningServer = app.listen(0, '127.0.0.1', () => resolve(listeningServer));
    });

    try {
        const { port } = server.address();
        const response = await fetch(`http://127.0.0.1:${port}/api/projects/project-1`);
        const project = await response.json();

        assert.equal(response.status, 200);
        assert.equal(project.title, 'Launch Video');
        assert.equal(project.client, 'Acme Studio');
        assert.equal(project.editor, 'Editor One');
        assert.equal(project.clientGuidelines, 'Use Inter SemiBold.\nKeep captions white.');
        assert.deepEqual(project.clientGuidelineProfile, {
            items: [],
            additionalNotes: 'Use Inter SemiBold.\nKeep captions white.'
        });
    } finally {
        Project.findById = originalFindProjectById;
        Client.findOne = originalFindClient;
        await new Promise((resolve, reject) => {
            server.close(error => error ? reject(error) : resolve());
        });
    }
});

test('project details resolve and prioritize the structured client profile', async () => {
    const clientModel = {
        findOne() {
            return {
                lean: async () => ({
                    guidelines: 'This compatibility copy is stale.',
                    guidelineItems: [
                        {
                            _id: 'avoid-1',
                            category: 'Audio',
                            instruction: 'Avoid clipping.',
                            ruleType: 'Avoid'
                        },
                        {
                            _id: 'must-1',
                            category: 'Font',
                            instruction: 'Use Inter.',
                            ruleType: 'Must Use'
                        },
                        {
                            _id: 'prefer-1',
                            category: 'Caption',
                            instruction: 'Use sentence case.',
                            ruleType: 'Prefer'
                        }
                    ],
                    guidelineNotes: 'Keep source files.'
                })
            };
        }
    };

    const result = await resolveClientGuidelineData('Acme Studio', clientModel);

    assert.deepEqual(
        result.clientGuidelineProfile.items.map(item => item._id),
        ['must-1', 'prefer-1', 'avoid-1']
    );
    assert.equal(result.clientGuidelineProfile.additionalNotes, 'Keep source files.');
    assert.match(result.clientGuidelines, /^\[Must Use\] Font:/);
    assert.doesNotMatch(result.clientGuidelines, /compatibility copy is stale/);
});

test('project details remain compatible when the client is missing or blank', async () => {
    let lookupCount = 0;
    const clientModel = {
        findOne() {
            lookupCount += 1;
            return { lean: async () => null };
        }
    };

    assert.equal(await resolveClientGuidelines('Legacy Client', clientModel), '');
    assert.equal(await resolveClientGuidelines('   ', clientModel), '');
    assert.equal(lookupCount, 1);
});

test('project details remain compatible with an existing client that predates guidelines', async () => {
    const clientModel = {
        findOne() {
            return { lean: async () => ({ name: 'Legacy Client' }) };
        }
    };

    assert.equal(await resolveClientGuidelines('Legacy Client', clientModel), '');
});
