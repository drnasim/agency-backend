const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeLiveTvConfig } = require('../routes/settings');

test('normalizes a valid ordered Live TV configuration', () => {
    const config = normalizeLiveTvConfig({
        servers: [
            { id: 'news', label: 'News', url: 'https://example.com/live' },
            { id: 'sports', label: 'Sports', url: 'http://example.net/#watch' }
        ]
    });

    assert.deepEqual(config, {
        servers: [
            { id: 'news', label: 'News', url: 'https://example.com/live' },
            { id: 'sports', label: 'Sports', url: 'http://example.net/#watch' }
        ]
    });
});

test('rejects unsafe, duplicate, empty, and oversized Live TV configurations', () => {
    assert.equal(normalizeLiveTvConfig({ servers: [] }), null);
    assert.equal(normalizeLiveTvConfig({
        servers: [{ id: 'one', label: 'One', url: 'javascript:alert(1)' }]
    }), null);
    assert.equal(normalizeLiveTvConfig({
        servers: [
            { id: 'same', label: 'One', url: 'https://example.com/1' },
            { id: 'same', label: 'Two', url: 'https://example.com/2' }
        ]
    }), null);
});
