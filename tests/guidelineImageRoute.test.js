const { after, test } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const jwt = require('jsonwebtoken');
const cron = require('node-cron');
const User = require('../models/User');

const existingCronTaskIds = new Set(cron.getTasks().keys());
const driveRoutes = require('../routes/drive');
const guidelineRouteCronTasks = Array.from(cron.getTasks())
    .filter(([taskId]) => !existingCronTaskIds.has(taskId))
    .map(([, task]) => task);

after(() => {
    for (const task of guidelineRouteCronTasks) task.destroy();
});

test('guideline image route authenticates before parsing and rejects unsupported files', async () => {
    const originalFindUser = User.findOne;
    const originalJwtSecret = process.env.JWT_SECRET;
    process.env.JWT_SECRET = 'guideline-image-route-test-secret';
    User.findOne = filter => ({
        select: async () => ({
            _id: filter._id,
            name: 'Test User',
            email: 'test@example.com',
            role: filter._id === 'admin-id' ? ['Admin'] : ['Editor'],
            isActive: true
        })
    });

    const app = express();
    app.use('/api/drive', driveRoutes);
    const server = await new Promise(resolve => {
        const listeningServer = app.listen(0, '127.0.0.1', () => resolve(listeningServer));
    });

    try {
        const { port } = server.address();
        const endpoint = `http://127.0.0.1:${port}/api/drive/guideline-image`;

        const anonymousResponse = await fetch(endpoint, { method: 'POST' });
        assert.equal(anonymousResponse.status, 401);

        const editorToken = jwt.sign({ sub: 'editor-id' }, process.env.JWT_SECRET);
        const editorResponse = await fetch(endpoint, {
            method: 'POST',
            headers: { authorization: `Bearer ${editorToken}` }
        });
        assert.equal(editorResponse.status, 403);

        const adminToken = jwt.sign({ sub: 'admin-id' }, process.env.JWT_SECRET);
        const adminResponse = await fetch(endpoint, {
            method: 'POST',
            headers: { authorization: `Bearer ${adminToken}` }
        });
        assert.equal(adminResponse.status, 400);
        assert.deepEqual(await adminResponse.json(), { error: 'No image uploaded' });

        const invalidUpload = new FormData();
        invalidUpload.append(
            'file',
            new Blob(['not an image'], { type: 'text/plain' }),
            'reference.txt'
        );
        const invalidMimeResponse = await fetch(endpoint, {
            method: 'POST',
            headers: { authorization: `Bearer ${adminToken}` },
            body: invalidUpload
        });
        assert.equal(invalidMimeResponse.status, 415);

        const spoofedImage = new FormData();
        spoofedImage.append(
            'file',
            new Blob(['plain text with a fake content type'], { type: 'image/png' }),
            'spoofed.png'
        );
        const spoofedImageResponse = await fetch(endpoint, {
            method: 'POST',
            headers: { authorization: `Bearer ${adminToken}` },
            body: spoofedImage
        });
        assert.equal(spoofedImageResponse.status, 415);
        assert.deepEqual(await spoofedImageResponse.json(), {
            error: 'Uploaded file content does not match its image type'
        });
    } finally {
        User.findOne = originalFindUser;
        if (originalJwtSecret === undefined) delete process.env.JWT_SECRET;
        else process.env.JWT_SECRET = originalJwtSecret;
        await new Promise((resolve, reject) => {
            server.close(error => error ? reject(error) : resolve());
        });
    }
});
