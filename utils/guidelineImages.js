const GUIDELINE_IMAGE_MAX_BYTES = 8 * 1024 * 1024;
const GUIDELINE_IMAGE_MIME_TYPES = Object.freeze([
    'image/jpeg',
    'image/png',
    'image/webp',
    'image/gif'
]);

const isAllowedGuidelineImageMimeType = value => (
    GUIDELINE_IMAGE_MIME_TYPES.includes(String(value || '').toLowerCase())
);

const detectGuidelineImageMimeType = (value) => {
    const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value || []);

    if (
        bytes.length >= 3 &&
        bytes[0] === 0xff &&
        bytes[1] === 0xd8 &&
        bytes[2] === 0xff
    ) {
        return 'image/jpeg';
    }
    if (
        bytes.length >= 8 &&
        bytes.subarray(0, 8).equals(
            Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
        )
    ) {
        return 'image/png';
    }

    const header = bytes.subarray(0, 12).toString('ascii');
    if (header.startsWith('GIF87a') || header.startsWith('GIF89a')) {
        return 'image/gif';
    }
    if (
        bytes.length >= 12 &&
        header.slice(0, 4) === 'RIFF' &&
        header.slice(8, 12) === 'WEBP'
    ) {
        return 'image/webp';
    }
    return '';
};

const normalizeGuidelineImageReferenceName = value => (
    String(value || '').slice(0, 255)
);

module.exports = {
    detectGuidelineImageMimeType,
    GUIDELINE_IMAGE_MAX_BYTES,
    GUIDELINE_IMAGE_MIME_TYPES,
    isAllowedGuidelineImageMimeType,
    normalizeGuidelineImageReferenceName
};
