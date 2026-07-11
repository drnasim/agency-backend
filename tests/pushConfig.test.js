const test = require('node:test');
const assert = require('node:assert/strict');
const webpush = require('web-push');
const { initializeWebPush, readPushConfig } = require('../config/push');

test('VAPID startup validation accepts one generated matching pair', () => {
    const pair = webpush.generateVAPIDKeys();
    const config = readPushConfig({
        VAPID_PUBLIC_KEY: pair.publicKey,
        VAPID_PRIVATE_KEY: pair.privateKey,
        VAPID_SUBJECT: 'mailto:test@example.com'
    });
    assert.equal(config.publicKey, pair.publicKey);
});

test('VAPID startup validation rejects missing and mismatched keys', () => {
    assert.throws(() => readPushConfig({}), /Missing environment variable/);
    const first = webpush.generateVAPIDKeys();
    const second = webpush.generateVAPIDKeys();
    assert.throws(() => readPushConfig({
        VAPID_PUBLIC_KEY: first.publicKey,
        VAPID_PRIVATE_KEY: second.privateKey,
        VAPID_SUBJECT: 'mailto:test@example.com'
    }), /matching P-256 key pair/);
});

test('optional Web Push initialization degrades without preventing server startup', () => {
    const client = {
        calls: [],
        setVapidDetails(...args) { this.calls.push(args); }
    };
    const missing = initializeWebPush(client, {});
    assert.equal(missing.available, false);
    assert.match(missing.error.message, /Missing environment variable/);
    assert.equal(client.calls.length, 0);

    const first = webpush.generateVAPIDKeys();
    const second = webpush.generateVAPIDKeys();
    const invalid = initializeWebPush(client, {
        VAPID_PUBLIC_KEY: first.publicKey,
        VAPID_PRIVATE_KEY: second.privateKey,
        VAPID_SUBJECT: 'mailto:test@example.com'
    });
    assert.equal(invalid.available, false);
    assert.match(invalid.error.message, /matching P-256 key pair/);
    assert.equal(client.calls.length, 0);
});

test('optional Web Push initialization preserves valid VAPID configuration', () => {
    const pair = webpush.generateVAPIDKeys();
    const calls = [];
    const client = { setVapidDetails: (...args) => calls.push(args) };
    const initialized = initializeWebPush(client, {
        VAPID_PUBLIC_KEY: pair.publicKey,
        VAPID_PRIVATE_KEY: pair.privateKey,
        VAPID_SUBJECT: 'mailto:test@example.com'
    });

    assert.equal(initialized.available, true);
    assert.equal(initialized.config.publicKey, pair.publicKey);
    assert.deepEqual(calls, [['mailto:test@example.com', pair.publicKey, pair.privateKey]]);
});
