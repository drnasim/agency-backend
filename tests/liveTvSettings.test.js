const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeLiveTvConfig } = require('../routes/settings');

test('normalizes a valid ordered Live TV configuration', () => {
    const config = normalizeLiveTvConfig({
        position: 'bottom-left',
        showServerList: false,
        servers: [
            { id: 'news', label: 'News', url: 'https://example.com/live' },
            { id: 'sports', label: 'Sports', url: 'http://example.net/#watch' }
        ]
    });

    assert.deepEqual(config, {
        position: 'bottom-left',
        showServerList: false,
        servers: [
            { id: 'news', label: 'News', url: 'https://example.com/live' },
            { id: 'sports', label: 'Sports', url: 'http://example.net/#watch' }
        ]
    });
});

test('keeps existing Live TV configurations visible by default', () => {
    const config = normalizeLiveTvConfig({
        position: 'top-right',
        servers: [{ id: 'one', label: 'One', url: 'https://example.com/live' }]
    });

    assert.equal(config.showServerList, true);
});

test('rejects unsafe, duplicate, empty, and oversized Live TV configurations', () => {
    assert.equal(normalizeLiveTvConfig({ position: 'middle', servers: [] }), null);
    assert.equal(normalizeLiveTvConfig({
        position: 'top-right',
        showServerList: 'yes',
        servers: [{ id: 'one', label: 'One', url: 'https://example.com/1' }]
    }), null);
    assert.equal(normalizeLiveTvConfig({
        position: 'top-right',
        servers: [{ id: 'one', label: 'One', url: 'javascript:alert(1)' }]
    }), null);
    assert.equal(normalizeLiveTvConfig({
        position: 'top-right',
        servers: [
            { id: 'same', label: 'One', url: 'https://example.com/1' },
            { id: 'same', label: 'Two', url: 'https://example.com/2' }
        ]
    }), null);
});
