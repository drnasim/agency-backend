const express = require('express');
const router = express.Router();
const multer = require('multer');
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');
const crypto = require('crypto');

// Multer setup (ফাইল মেমোরিতে রিসিভ করার জন্য)
const storage = multer.memoryStorage();
const upload = multer({ storage: storage, limits: { fileSize: 100 * 1024 * 1024 } }); // 100MB Limit

// ========================================================
// Cloudflare R2 Credentials (তোমার সেভ করা তথ্যগুলো এখানে বসাও)
// ========================================================
const R2_ACCOUNT_ID = "ec1a5dda099ea03919c8c71be150d606"; // তোমার স্ক্রিনশট থেকে অ্যাকাউন্ট আইডি দিয়ে দিয়েছি
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

router.post('/media', upload.single('file'), async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ error: 'No file uploaded' });
        }

        // ফাইলের নাম ইউনিক করার জন্য
        const fileExtension = req.file.originalname.split('.').pop();
        const randomName = crypto.randomBytes(16).toString('hex');
        const fileName = `${randomName}.${fileExtension}`;

        const uploadParams = {
            Bucket: BUCKET_NAME,
            Key: fileName,
            Body: req.file.buffer,
            ContentType: req.file.mimetype,
        };

        // Cloudflare R2 তে আপলোড
        await s3Client.send(new PutObjectCommand(uploadParams));

        // আপলোড শেষে পাবলিক লিংক রিটার্ন করা
        const fileUrl = `${PUBLIC_DEV_URL}/${fileName}`;
        res.status(200).json({ fileUrl });

    } catch (error) {
        console.error("Cloudflare R2 Upload Error:", error);
        res.status(500).json({ error: 'Failed to upload media to Cloudflare R2' });
    }
});

module.exports = router;