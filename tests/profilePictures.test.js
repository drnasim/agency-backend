const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const jwt = require('jsonwebtoken');
const User = require('../models/User');

const previousJwtSecret = process.env.JWT_SECRET;
process.env.JWT_SECRET = 'profile-picture-test-secret';

const authRouter = require('../routes/auth');
const {
    PUBLIC_USER_FIELDS,
    buildLoginResponse,
    buildProfileUpdatedPayload
} = authRouter;

test.after(() => {
    if (previousJwtSecret === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = previousJwtSecret;
});

const startAuthServer = async () => {
    const app = express();
    app.use(express.json());
    app.use('/api/auth', authRouter);
    return new Promise(resolve => {
        const server = app.listen(0, '127.0.0.1', () => resolve(server));
    });
};

const closeServer = server => new Promise((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve());
});

test('login responses include the persisted profile picture with an empty fallback', () => {
    const response = buildLoginResponse({
        _id: 'user-with-avatar',
        name: 'Avatar User',
        email: 'avatar@example.com',
        role: ['Editor'],
        profilePic: 'https://images.example.com/avatar.jpg'
    }, 'Editor');

    assert.equal(response.profilePic, 'https://images.example.com/avatar.jpg');
    assert.equal(jwt.verify(response.token, process.env.JWT_SECRET).sub, 'user-with-avatar');

    const fallback = buildLoginResponse({
        _id: 'user-without-avatar',
        name: 'No Avatar',
        email: 'no-avatar@example.com',
        role: ['Editor']
    }, 'Editor');
    assert.equal(fallback.profilePic, '');
});

test('profile update socket payload exposes only public avatar identity fields', () => {
    assert.deepEqual(buildProfileUpdatedPayload({
        _id: 'profile-user-id',
        name: 'New Name',
        email: 'profile@example.com',
        profilePic: 'https://images.example.com/new-avatar.jpg',
        password: 'must-not-leak',
        phone: '+1-secret',
        fcmToken: 'must-not-leak'
    }, 'Old Name'), {
        _id: 'profile-user-id',
        name: 'New Name',
        previousName: 'Old Name',
        email: 'profile@example.com',
        profilePic: 'https://images.example.com/new-avatar.jpg'
    });
});

test('user directory selects and returns profile pictures', async t => {
    const originalFind = User.find;
    let selectedFields = '';
    let receivedFilter;
    User.find = filter => {
        receivedFilter = filter;
        return {
            select: async fields => {
                selectedFields = fields;
                return [{
                    _id: 'directory-user-id',
                    name: 'Directory User',
                    email: 'directory@example.com',
                    role: ['Editor'],
                    profilePic: 'https://images.example.com/directory-avatar.jpg'
                }];
            }
        };
    };
    t.after(() => { User.find = originalFind; });

    const server = await startAuthServer();
    t.after(() => closeServer(server));

    const response = await fetch(
        `http://127.0.0.1:${server.address().port}/api/auth/users?role=Editor`
    );

    assert.equal(response.status, 200);
    assert.deepEqual(receivedFilter, { role: 'Editor' });
    assert.equal(selectedFields, PUBLIC_USER_FIELDS);
    assert.match(selectedFields, /\bprofilePic\b/);
    assert.deepEqual(await response.json(), [{
        _id: 'directory-user-id',
        name: 'Directory User',
        email: 'directory@example.com',
        role: ['Editor'],
        profilePic: 'https://images.example.com/directory-avatar.jpg'
    }]);
});

test('successful profile updates broadcast the saved public avatar payload', async t => {
    const originalFindOne = User.findOne;
    const previousIo = global.io;
    let saveCompleted = false;
    const emissions = [];
    const user = {
        _id: 'updated-user-id',
        name: 'Previous Name',
        email: 'updated@example.com',
        role: ['Editor'],
        phone: '',
        profilePic: 'https://images.example.com/old-avatar.jpg',
        password: 'must-not-leak',
        save: async function save() {
            saveCompleted = true;
            return this;
        }
    };

    User.findOne = async filter => {
        assert.deepEqual(filter, { email: 'updated@example.com' });
        return user;
    };
    global.io = {
        emit: (event, payload) => emissions.push({ event, payload, saveCompleted })
    };
    t.after(() => {
        User.findOne = originalFindOne;
        if (previousIo === undefined) delete global.io;
        else global.io = previousIo;
    });

    const server = await startAuthServer();
    t.after(() => closeServer(server));

    const response = await fetch(
        `http://127.0.0.1:${server.address().port}/api/auth/update`,
        {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                currentEmail: 'updated@example.com',
                name: 'Updated Name',
                profilePic: 'https://images.example.com/updated-avatar.jpg'
            })
        }
    );

    assert.equal(response.status, 200);
    assert.equal((await response.json()).profilePic, 'https://images.example.com/updated-avatar.jpg');
    assert.deepEqual(emissions, [{
        event: 'profile_updated',
        saveCompleted: true,
        payload: {
            _id: 'updated-user-id',
            name: 'Updated Name',
            previousName: 'Previous Name',
            email: 'updated@example.com',
            profilePic: 'https://images.example.com/updated-avatar.jpg'
        }
    }]);
});
