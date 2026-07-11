const webpush = require('web-push');
const crypto = require('crypto');

let configured = false;

const readPushConfig = (env = process.env) => {
    const config = {
        publicKey: String(env.VAPID_PUBLIC_KEY || '').trim(),
        privateKey: String(env.VAPID_PRIVATE_KEY || '').trim(),
        subject: String(env.VAPID_SUBJECT || '').trim()
    };

    const missing = Object.entries(config)
        .filter(([, value]) => !value)
        .map(([key]) => ({ publicKey: 'VAPID_PUBLIC_KEY', privateKey: 'VAPID_PRIVATE_KEY', subject: 'VAPID_SUBJECT' })[key]);

    if (missing.length) {
        throw new Error(`Browser push is not configured. Missing environment variable(s): ${missing.join(', ')}`);
    }

    if (!/^(mailto:|https:\/\/)/i.test(config.subject)) {
        throw new Error('VAPID_SUBJECT must be a mailto: address or an https:// URL');
    }

    const decodeBase64Url = (value) => Buffer.from(
        value.replace(/-/g, '+').replace(/_/g, '/'),
        'base64'
    );

    try {
        const publicKey = decodeBase64Url(config.publicKey);
        const privateKey = decodeBase64Url(config.privateKey);
        if (publicKey.length !== 65 || publicKey[0] !== 4 || privateKey.length !== 32) {
            throw new Error('unexpected key length');
        }

        const publicKeyValidator = crypto.createECDH('prime256v1');
        publicKeyValidator.setPublicKey(publicKey);

        const keyPairValidator = crypto.createECDH('prime256v1');
        keyPairValidator.setPrivateKey(privateKey);
        if (!keyPairValidator.getPublicKey().equals(publicKey)) {
            throw new Error('public and private keys do not match');
        }
    } catch (error) {
        throw new Error(`VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY must be a matching P-256 key pair (${error.message})`);
    }

    return config;
};

const configureWebPush = (client = webpush, env = process.env) => {
    const config = readPushConfig(env);
    if (!configured || client !== webpush) {
        try {
            client.setVapidDetails(config.subject, config.publicKey, config.privateKey);
        } catch (error) {
            throw new Error(`Invalid VAPID configuration: ${error.message}`);
        }
        if (client === webpush) configured = true;
    }
    return config;
};

const initializeWebPush = (client = webpush, env = process.env) => {
    try {
        return {
            available: true,
            config: configureWebPush(client, env),
            error: null
        };
    } catch (error) {
        return {
            available: false,
            config: null,
            error
        };
    }
};

module.exports = { configureWebPush, initializeWebPush, readPushConfig };
