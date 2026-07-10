const test = require('node:test');
const assert = require('node:assert/strict');
const webpush = require('web-push');
const { readPushConfig } = require('../config/push');

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
