const multer = require('multer');
// Photos are sent as one base64 multipart field, not as arbitrary server paths/URLs.
const parsePhoto = multer({ limits: { fieldSize: 8 * 1024 * 1024, fields: 1, files: 0, parts: 2 } }).none();
const photoMultipart = (req, res, next) => parsePhoto(req, res, error => error
    ? res.status(400).json({ error: 'Choose a photo smaller than 6 MB.' }) : next());

const createPhotoUploadHandler = (fetchImage = (...args) => fetch(...args)) => async (req, res) => {
    const image = req.body?.image;
    if (typeof image !== 'string' || !image.length || image.length > 8 * 1024 * 1024 || !/^[A-Za-z0-9+/]+={0,2}$/.test(image)) {
        return res.status(400).json({ error: 'Choose a valid photo smaller than 6 MB.' });
    }
    const bytes = Buffer.from(image, 'base64');
    const jpeg = bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
    const png = bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]));
    const webp = bytes.toString('ascii',0,4) === 'RIFF' && bytes.toString('ascii',8,12) === 'WEBP';
    if ((!jpeg && !png && !webp) || bytes.length > 6 * 1024 * 1024) return res.status(400).json({ error: 'Choose a JPEG, PNG or WebP photo smaller than 6 MB.' });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30000);
    try {
        const form = new FormData(); form.append('image', image);
        // Same storage provider as existing web avatars; credentials stay server-side for mobile uploads.
        const key = process.env.IMGBB_API_KEY || '2482183aeb2bc89a1242f1177211ebba';
        const response = await fetchImage(`https://api.imgbb.com/1/upload?key=${encodeURIComponent(key)}`, { method: 'POST', body: form, signal: controller.signal });
        const result = await response.json();
        const profilePic = result?.data?.url;
        if (!response.ok || !result.success || typeof profilePic !== 'string' || !/^https:\/\//i.test(profilePic)) throw new Error('Upload rejected');
        return res.json({ profilePic });
    } catch {
        return res.status(502).json({ error: 'Your photo could not be uploaded. Please try again.' });
    } finally { clearTimeout(timer); }
};
module.exports = { photoMultipart, createPhotoUploadHandler };
