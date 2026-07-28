const test = require('node:test');
const assert = require('node:assert/strict');
const {
    detectGuidelineImageMimeType,
    GUIDELINE_IMAGE_MAX_BYTES,
    GUIDELINE_IMAGE_MIME_TYPES,
    isAllowedGuidelineImageMimeType,
    normalizeGuidelineImageReferenceName
} = require('../utils/guidelineImages');

test('guideline reference uploads use a narrow image allowlist and 8 MB limit', () => {
    assert.equal(GUIDELINE_IMAGE_MAX_BYTES, 8 * 1024 * 1024);
    assert.deepEqual(GUIDELINE_IMAGE_MIME_TYPES, [
        'image/jpeg',
        'image/png',
        'image/webp',
        'image/gif'
    ]);

    for (const mimeType of GUIDELINE_IMAGE_MIME_TYPES) {
        assert.equal(isAllowedGuidelineImageMimeType(mimeType), true);
    }
    assert.equal(isAllowedGuidelineImageMimeType('image/svg+xml'), false);
    assert.equal(isAllowedGuidelineImageMimeType('text/html'), false);
    assert.equal(isAllowedGuidelineImageMimeType('application/pdf'), false);
});

test('guideline image signatures identify only supported image bytes', () => {
    assert.equal(
        detectGuidelineImageMimeType(Buffer.from([0xff, 0xd8, 0xff, 0xe0])),
        'image/jpeg'
    );
    assert.equal(
        detectGuidelineImageMimeType(
            Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
        ),
        'image/png'
    );
    assert.equal(
        detectGuidelineImageMimeType(Buffer.from('GIF89a', 'ascii')),
        'image/gif'
    );
    assert.equal(
        detectGuidelineImageMimeType(
            Buffer.from('RIFF0000WEBP', 'ascii')
        ),
        'image/webp'
    );
    assert.equal(
        detectGuidelineImageMimeType(Buffer.from('<script>alert(1)</script>')),
        ''
    );
});

test('guideline reference names are capped to the Client schema limit', () => {
    const referenceName = normalizeGuidelineImageReferenceName('x'.repeat(300));
    assert.equal(referenceName.length, 255);
});
