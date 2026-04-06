const express = require('express');
const router = express.Router();
const multer = require('multer');
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const os = require('os');

// ✅ OOM Fix: memoryStorage → diskStorage (ফাইল RAM এ না রেখে ডিস্কে টেম্প ফাইল হিসেবে রাখবে)
const tmpDir = path.join(os.tmpdir(), 'fortivus-uploads');
if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });

const diskStorage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, tmpDir),
    filename: (req, file, cb) => cb(null, `${Date.now()}-${file.originalname}`)
});
const upload = multer({ storage: diskStorage, limits: { fileSize: 100 * 1024 * 1024 } }); // 100MB Limit

// ========================================================
// Cloudflare R2 Credentials (তোমার সেভ করা তথ্যগুলো এখানে বসাও)
// ========================================================
const R2_ACCOUNT_ID = "ec1a5dda099ea03919c8c71be150d606"; // তোমার স্ক্রিনশট থেকে অ্যাকাউন্ট আইডি দিয়ে দিয়েছি
const S3_API_ENDPOINT = `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`;

const R2_ACCESS_KEY_ID = "এখানে_তোমার_Access_Key_ID_বসাও";
const R2_SECRET_ACCESS_KEY = "এখানে_তোমার_Secret_Access_Key_বসাও";
const BUCKET_NAME = "fortivus-chat";
const PUBLIC_DEV_URL = "এখানে_তোমার_R2_dev_লিংক_বসাও"; // যেমন: https://pub-xxxxxxx.r2.dev
// ========================================================

const s3Client = new S3Client({
    region: "auto",
    endpoint: S3_API_ENDPOINT,
    credentials: {
        accessKeyId: R2_ACCESS_KEY_ID,
        secretAccessKey: R2_SECRET_ACCESS_KEY,
    },
});

// ✅ টেম্প ফাইল সেইফলি ডিলিট করার হেল্পার
const cleanupTempFile = (filePath) => {
    if (filePath) {
        fs.unlink(filePath, (err) => {
            if (err && err.code !== 'ENOENT') console.error('Temp file cleanup error:', err.message);
        });
    }
};

router.post('/media', upload.single('file'), async (req, res) => {
    const tempFilePath = req.file?.path;

    try {
        if (!req.file) {
            return res.status(400).json({ error: 'No file uploaded' });
        }

        // ফাইলের নাম ইউনিক করার জন্য
        const fileExtension = req.file.originalname.split('.').pop();
        const randomName = crypto.randomBytes(16).toString('hex');
        const fileName = `${randomName}.${fileExtension}`;

        // ✅ OOM Fix: Buffer এর বদলে Stream ব্যবহার
        const fileStream = fs.createReadStream(tempFilePath);

        const uploadParams = {
            Bucket: BUCKET_NAME,
            Key: fileName,
            Body: fileStream,  // ✅ আগে req.file.buffer ছিল — এখন stream
            ContentType: req.file.mimetype,
        };

        // Cloudflare R2 তে আপলোড
        await s3Client.send(new PutObjectCommand(uploadParams));

        // ✅ আপলোড শেষে টেম্প ফাইল ডিলিট
        cleanupTempFile(tempFilePath);

        // আপলোড শেষে পাবলিক লিংক রিটার্ন করা
        const fileUrl = `${PUBLIC_DEV_URL}/${fileName}`;
        res.status(200).json({ fileUrl });

    } catch (error) {
        console.error("Cloudflare R2 Upload Error:", error);
        cleanupTempFile(tempFilePath);
        res.status(500).json({ error: 'Failed to upload media to Cloudflare R2' });
    }
});

module.exports = router;