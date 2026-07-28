const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const jwt = require('jsonwebtoken');
const Settings = require('../models/Settings');
const User = require('../models/User');
const settingsRoutes = require('../routes/settings');
const {
    DEFAULT_GUIDELINE_CATEGORIES,
    addGuidelineCategory,
    buildGuidelineCategoryCatalog,
    deleteGuidelineCategory,
    normalizeStoredGuidelineCategories,
    renameGuidelineCategory
} = settingsRoutes;

const createSettingsModel = (initialPayments = []) => {
    let storedDocument = {
        type: 'guidelineCategories',
        payments: [...initialPayments],
        async save() {
            storedDocument = this;
            return this;
        }
    };

    class FakeSettings {
        constructor(value) {
            Object.assign(this, value);
        }

        async save() {
            storedDocument = this;
            return this;
        }

        static findOne() {
            return {
                then(resolve, reject) {
                    return Promise.resolve(storedDocument).then(resolve, reject);
                },
                lean: async () => ({
                    type: storedDocument.type,
                    payments: [...storedDocument.payments]
                })
            };
        }
    }

    return {
        FakeSettings,
        get payments() {
            return Array.from(storedDocument.payments);
        }
    };
};

test('category catalog keeps defaults first and normalizes custom names stably', () => {
    assert.deepEqual(DEFAULT_GUIDELINE_CATEGORIES, [
        'Font',
        'Color',
        'Caption',
        'Highlight',
        'Background',
        'Transition',
        'Audio'
    ]);
    assert.deepEqual(
        normalizeStoredGuidelineCategories([
            '  Brand   Voice ',
            'brand voice',
            { name: ' Framing ' },
            'font',
            ''
        ]),
        ['Brand Voice', 'Framing']
    );
    assert.deepEqual(
        buildGuidelineCategoryCatalog(['Brand Voice']).map(category => category.name),
        [...DEFAULT_GUIDELINE_CATEGORIES, 'Brand Voice']
    );
});

test('custom categories reject whitespace/case-insensitive duplicates', async () => {
    const storage = createSettingsModel(['Brand Voice']);

    await assert.rejects(
        addGuidelineCategory('  brand   voice ', storage.FakeSettings),
        error => error.statusCode === 409
    );

    const categories = await addGuidelineCategory(' Framing ', storage.FakeSettings);
    assert.equal(categories.at(-1).name, 'Framing');
    assert.deepEqual(storage.payments, ['Brand Voice', 'Framing']);
});

test('renaming a custom category cascades through clients and refreshes legacy text', async () => {
    const storage = createSettingsModel(['Brand Voice', 'Framing']);
    let clientSaveCount = 0;
    const clients = [{
        guidelineItems: [
            { category: 'Brand Voice', instruction: 'Keep it warm.', ruleType: 'Must Use' },
            { category: 'Audio', instruction: 'Use clean audio.', ruleType: 'Prefer' }
        ],
        guidelineNotes: 'Existing notes.',
        guidelines: '',
        async save() {
            clientSaveCount += 1;
        }
    }];
    const clientModel = {
        async find(query) {
            assert.ok(query['guidelineItems.category'] instanceof RegExp);
            return clients;
        }
    };

    const categories = await renameGuidelineCategory(
        ' brand voice ',
        'Tone of Voice',
        storage.FakeSettings,
        clientModel
    );

    assert.equal(clients[0].guidelineItems[0].category, 'Tone of Voice');
    assert.match(clients[0].guidelines, /\[Must Use\] Tone of Voice: Keep it warm\./);
    assert.equal(clientSaveCount, 1);
    assert.deepEqual(storage.payments, ['Tone of Voice', 'Framing']);
    assert.equal(categories.at(-2).name, 'Tone of Voice');
});

test('default categories are immutable and custom deletion is blocked while in use', async () => {
    const storage = createSettingsModel(['Brand Voice']);

    await assert.rejects(
        renameGuidelineCategory(
            'Font',
            'Typography',
            storage.FakeSettings,
            { find: async () => [] }
        ),
        error => error.statusCode === 400
    );
    await assert.rejects(
        deleteGuidelineCategory(
            'font',
            storage.FakeSettings,
            { exists: async () => null }
        ),
        error => error.statusCode === 400
    );
    await assert.rejects(
        deleteGuidelineCategory(
            'Brand Voice',
            storage.FakeSettings,
            { exists: async () => ({ _id: 'client-1' }) }
        ),
        error => error.statusCode === 409
    );
    assert.deepEqual(storage.payments, ['Brand Voice']);
});

test('unused custom categories can be deleted without changing default order', async () => {
    const storage = createSettingsModel(['Brand Voice', 'Framing']);
    const categories = await deleteGuidelineCategory(
        'brand voice',
        storage.FakeSettings,
        { exists: async () => null }
    );

    assert.deepEqual(storage.payments, ['Framing']);
    assert.deepEqual(
        categories.map(category => category.name),
        [...DEFAULT_GUIDELINE_CATEGORIES, 'Framing']
    );
});

test('category HTTP route is public to read and Admin-only to mutate', async () => {
    const originalFindSettings = Settings.findOne;
    const originalFindUser = User.findOne;
    const originalJwtSecret = process.env.JWT_SECRET;
    const settingsDocument = {
        type: 'guidelineCategories',
        payments: ['Brand Voice'],
        async save() {
            return this;
        }
    };

    Settings.findOne = () => ({
        then(resolve, reject) {
            return Promise.resolve(settingsDocument).then(resolve, reject);
        },
        lean: async () => ({
            type: settingsDocument.type,
            payments: [...settingsDocument.payments]
        })
    });
    User.findOne = filter => ({
        select: async () => ({
            _id: filter._id,
            name: 'Test User',
            email: 'test@example.com',
            role: filter._id === 'admin-id' ? ['Admin'] : ['Editor'],
            isActive: true
        })
    });
    process.env.JWT_SECRET = 'guideline-category-test-secret';

    const app = express();
    app.use(express.json());
    app.use('/api/settings', settingsRoutes);
    const server = await new Promise(resolve => {
        const listeningServer = app.listen(0, '127.0.0.1', () => resolve(listeningServer));
    });

    try {
        const { port } = server.address();
        const baseUrl = `http://127.0.0.1:${port}/api/settings/guideline-categories`;
        const publicResponse = await fetch(baseUrl);
        assert.equal(publicResponse.status, 200);
        assert.equal((await publicResponse.json()).categories.at(-1).name, 'Brand Voice');

        const unauthenticatedResponse = await fetch(baseUrl, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ name: 'Framing' })
        });
        assert.equal(unauthenticatedResponse.status, 401);

        const editorToken = jwt.sign({ sub: 'editor-id' }, process.env.JWT_SECRET);
        const editorResponse = await fetch(baseUrl, {
            method: 'POST',
            headers: {
                authorization: `Bearer ${editorToken}`,
                'content-type': 'application/json'
            },
            body: JSON.stringify({ name: 'Framing' })
        });
        assert.equal(editorResponse.status, 403);

        const adminToken = jwt.sign({ sub: 'admin-id' }, process.env.JWT_SECRET);
        const adminResponse = await fetch(baseUrl, {
            method: 'POST',
            headers: {
                authorization: `Bearer ${adminToken}`,
                'content-type': 'application/json'
            },
            body: JSON.stringify({ name: 'Framing' })
        });
        const adminBody = await adminResponse.json();
        assert.equal(adminResponse.status, 201);
        assert.equal(adminBody.categories.at(-1).name, 'Framing');
        assert.equal(adminBody.categories.at(-1).isDefault, false);
    } finally {
        Settings.findOne = originalFindSettings;
        User.findOne = originalFindUser;
        if (originalJwtSecret === undefined) delete process.env.JWT_SECRET;
        else process.env.JWT_SECRET = originalJwtSecret;
        await new Promise((resolve, reject) => {
            server.close(error => error ? reject(error) : resolve());
        });
    }
});
