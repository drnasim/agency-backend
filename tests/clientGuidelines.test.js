const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const Client = require('../models/Client');
const Project = require('../models/Project');
const projectRoutes = require('../routes/projects');
const { resolveClientGuidelines } = projectRoutes;

test('client schema stores reusable guidelines as optional plain text', () => {
    const guidelinesPath = Client.schema.path('guidelines');

    assert.equal(guidelinesPath.instance, 'String');
    assert.equal(guidelinesPath.defaultValue, '');
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
    } finally {
        Project.findById = originalFindProjectById;
        Client.findOne = originalFindClient;
        await new Promise((resolve, reject) => {
            server.close(error => error ? reject(error) : resolve());
        });
    }
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
