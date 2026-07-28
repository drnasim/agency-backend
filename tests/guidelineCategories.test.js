const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const jwt = require('jsonwebtoken');
const Client = require('../models/Client');
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
const {
    GUIDELINE_CATEGORY_CATALOG_VERSION,
    getGuidelineCategoryNames
} = require('../utils/guidelineCategories');

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
        },
        get categoryNames() {
            return getGuidelineCategoryNames(storedDocument.payments);
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
    assert.deepEqual(
        buildGuidelineCategoryCatalog([{
            version: GUIDELINE_CATEGORY_CATALOG_VERSION,
            categories: ['Brand Voice']
        }]),
        [{ name: 'Brand Voice', isDefault: false }]
    );
});

test('first catalog read migrates legacy custom storage to a versioned full catalog', async () => {
    const storage = createSettingsModel(['Brand Voice']);
    const categories = await settingsRoutes.getGuidelineCategorySettings(
        storage.FakeSettings
    );

    assert.deepEqual(
        categories.map(category => category.name),
        [...DEFAULT_GUIDELINE_CATEGORIES, 'Brand Voice']
    );
    assert.equal(storage.payments[0].version, GUIDELINE_CATEGORY_CATALOG_VERSION);
    assert.deepEqual(
        storage.payments[0].categories,
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
    assert.deepEqual(
        storage.categoryNames,
        [...DEFAULT_GUIDELINE_CATEGORIES, 'Brand Voice', 'Framing']
    );
    assert.equal(storage.payments[0].version, GUIDELINE_CATEGORY_CATALOG_VERSION);
});

test('renaming any category migrates the catalog and cascades through clients', async () => {
    const storage = createSettingsModel(['Brand Voice', 'Framing']);
    let clientSaveCount = 0;
    const clients = [{
        guidelineItems: [
            { category: 'font', instruction: 'Use Inter.', ruleType: 'Must Use' },
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

    const result = await renameGuidelineCategory(
        ' font ',
        'Typography',
        storage.FakeSettings,
        clientModel
    );

    assert.equal(clients[0].guidelineItems[0].category, 'Typography');
    assert.match(clients[0].guidelines, /\[Must Use\] Typography: Use Inter\./);
    assert.equal(clientSaveCount, 1);
    assert.equal(result.affectedCount, 1);
    assert.equal(result.categories[0].name, 'Typography');
    assert.equal(result.categories[0].isDefault, false);
    assert.equal(storage.payments[0].version, GUIDELINE_CATEGORY_CATALOG_VERSION);
    assert.equal(storage.categoryNames.includes('Font'), false);

    const reloadedCatalog = await settingsRoutes.getGuidelineCategorySettings(
        storage.FakeSettings
    );
    assert.equal(reloadedCatalog.some(category => category.name === 'Font'), false);
    assert.equal(reloadedCatalog[0].name, 'Typography');
});

test('deleting an in-use category cascades to a canonical replacement', async () => {
    const storage = createSettingsModel(['Brand Voice', 'Framing']);
    const client = {
        guidelineItems: [
            { category: 'BRAND VOICE', instruction: 'Warm tone.', ruleType: 'Prefer' },
            { category: 'Brand Voice', instruction: 'No jargon.', ruleType: 'Avoid' }
        ],
        guidelineNotes: '',
        guidelines: 'old',
        async save() {}
    };
    const result = await deleteGuidelineCategory(
        ' brand voice ',
        ' framing ',
        storage.FakeSettings,
        { find: async () => [client] }
    );

    assert.equal(result.affectedCount, 2);
    assert.equal(result.categories.some(category => category.name === 'Brand Voice'), false);
    assert.deepEqual(client.guidelineItems.map(item => item.category), ['Framing', 'Framing']);
    assert.match(client.guidelines, /\[Prefer\] Framing: Warm tone\./);
    assert.equal(storage.categoryNames.includes('Brand Voice'), false);
});

test('deleting a default category can move its rules to Uncategorized permanently', async () => {
    const storage = createSettingsModel(['Brand Voice']);
    const client = {
        guidelineItems: [{
            category: 'COLOR',
            instruction: 'Use brand blue.',
            ruleType: 'Prefer'
        }],
        guidelineNotes: '',
        guidelines: 'old',
        async save() {}
    };

    const result = await deleteGuidelineCategory(
        'color',
        null,
        storage.FakeSettings,
        { find: async () => [client] }
    );

    assert.equal(result.affectedCount, 1);
    assert.equal(client.guidelineItems[0].category, '');
    assert.equal(client.guidelines, '[Prefer] Uncategorized: Use brand blue.');
    assert.equal(result.categories.some(category => category.name === 'Color'), false);

    const reloadedCatalog = await settingsRoutes.getGuidelineCategorySettings(
        storage.FakeSettings
    );
    assert.equal(reloadedCatalog.some(category => category.name === 'Color'), false);
});

test('replacement validation is non-mutating and deleting the last category stays empty', async () => {
    const versionedPayments = [{
        version: GUIDELINE_CATEGORY_CATALOG_VERSION,
        categories: ['Only', 'Replacement']
    }];
    const storage = createSettingsModel(versionedPayments);
    let findCount = 0;
    const clientModel = {
        async find() {
            findCount += 1;
            return [];
        }
    };

    await assert.rejects(
        deleteGuidelineCategory(
            'Only',
            'only',
            storage.FakeSettings,
            clientModel
        ),
        error => error.statusCode === 400
    );
    await assert.rejects(
        deleteGuidelineCategory(
            'Only',
            'Missing',
            storage.FakeSettings,
            clientModel
        ),
        error => error.statusCode === 400
    );
    assert.equal(findCount, 0);
    assert.deepEqual(storage.categoryNames, ['Only', 'Replacement']);

    await deleteGuidelineCategory(
        'Only',
        'Replacement',
        storage.FakeSettings,
        clientModel
    );
    const finalResult = await deleteGuidelineCategory(
        'Replacement',
        '',
        storage.FakeSettings,
        clientModel
    );
    assert.deepEqual(finalResult.categories, []);
    assert.deepEqual(storage.categoryNames, []);
    assert.deepEqual(
        await settingsRoutes.getGuidelineCategorySettings(storage.FakeSettings),
        []
    );
});

test('category HTTP route is public to read and Admin-only to mutate', async () => {
    const originalFindSettings = Settings.findOne;
    const originalFindUser = User.findOne;
    const originalFindClients = Client.find;
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

        const client = {
            guidelineItems: [{
                category: 'Font',
                instruction: 'Use Inter.',
                ruleType: 'Must Use'
            }],
            guidelineNotes: '',
            guidelines: '',
            async save() {}
        };
        Client.find = async () => [client];
        const deleteResponse = await fetch(`${baseUrl}/Font`, {
            method: 'DELETE',
            headers: {
                authorization: `Bearer ${adminToken}`,
                'content-type': 'application/json'
            },
            body: JSON.stringify({ replacementCategory: 'Color' })
        });
        const deleteBody = await deleteResponse.json();
        assert.equal(deleteResponse.status, 200);
        assert.equal(deleteBody.affectedCount, 1);
        assert.equal(client.guidelineItems[0].category, 'Color');
        assert.equal(
            deleteBody.categories.some(category => category.name === 'Font'),
            false
        );
    } finally {
        Settings.findOne = originalFindSettings;
        User.findOne = originalFindUser;
        Client.find = originalFindClients;
        if (originalJwtSecret === undefined) delete process.env.JWT_SECRET;
        else process.env.JWT_SECRET = originalJwtSecret;
        await new Promise((resolve, reject) => {
            server.close(error => error ? reject(error) : resolve());
        });
    }
});
