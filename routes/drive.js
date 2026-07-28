const express = require('express');
const router = express.Router();
const multer = require('multer');
const { google } = require('googleapis');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const cron = require('node-cron');
const { authenticate, requireAdmin } = require('../middleware/authenticate');
const {
    detectGuidelineImageMimeType,
    GUIDELINE_IMAGE_MAX_BYTES,
    GUIDELINE_IMAGE_MIME_TYPES,
    isAllowedGuidelineImageMimeType,
    normalizeGuidelineImageReferenceName
} = require('../utils/guidelineImages');

// ✅ OOM Fix: memoryStorage → diskStorage (ফাইল RAM এ না রেখে ডিস্কে টেম্প ফাইল হিসেবে রাখবে)
const tmpDir = path.join(os.tmpdir(), 'fortivus-uploads');
if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });

const diskStorage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, tmpDir),
    filename: (req, file, cb) => cb(null, `${Date.now()}-${file.originalname}`)
});
const upload = multer({ storage: diskStorage, limits: { fileSize: 100 * 1024 * 1024 } }); // 100MB
const guidelineImageStorage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, tmpDir),
    filename: (req, file, cb) => cb(
        null,
        `guideline-${Date.now()}-${crypto.randomBytes(8).toString('hex')}`
    )
});
const guidelineImageUpload = multer({
    storage: guidelineImageStorage,
    limits: { fileSize: GUIDELINE_IMAGE_MAX_BYTES, files: 1 },
    fileFilter: (req, file, callback) => {
        if (!isAllowedGuidelineImageMimeType(file.mimetype)) {
            const error = new Error(
                `Guideline images must be one of: ${GUIDELINE_IMAGE_MIME_TYPES.join(', ')}`
            );
            error.code = 'UNSUPPORTED_GUIDELINE_IMAGE';
            return callback(error);
        }
        return callback(null, true);
    }
});

// ==============================================================
// হেল্পার ফাংশন: ড্রাইভে ফোল্ডার খোঁজা বা নতুন করে তৈরি করা
// ==============================================================
async function getOrCreateFolder(drive, folderName, parentFolderId) {
    try {
        // ✅ Fix: ফোল্ডারের নামে সিঙ্গেল কোট (') থাকলে সেটা গুগল ড্রাইভ এপিআইতে এরর দেয়, তাই সেটা এস্কেপ করা হলো
        const safeFolderName = folderName.replace(/'/g, "\\'");
        
        const query = `mimeType='application/vnd.google-apps.folder' and name='${safeFolderName}' and trashed=false ${parentFolderId ? `and '${parentFolderId}' in parents` : ''}`;
        const response = await drive.files.list({
            q: query,
            fields: 'files(id, name)',
            spaces: 'drive'
        });

        if (response.data.files.length > 0) {
            return response.data.files[0].id;
        }

        const fileMetadata = {
            name: folderName,
            mimeType: 'application/vnd.google-apps.folder',
            parents: parentFolderId ? [parentFolderId] : []
        };

        const folder = await drive.files.create({
            requestBody: fileMetadata, // ✅ Fix: 'resource' এর বদলে 'requestBody' ব্যবহার করতে হবে (নতুন গুগল এপিআই রুল)
            fields: 'id'
        });

        return folder.data.id;
    } catch (error) {
        console.error('Folder creation error:', error);
        throw error;
    }
}

// ==============================================================
// অদৃশ্য স্পেস বা গ্যাপ মুছে ফেলার স্মার্ট ফাংশন (.trim)
// ==============================================================
const getAuth = () => {
    const clientId = (process.env.DRIVE_CLIENT_ID || '').trim();
    const clientSecret = (process.env.DRIVE_CLIENT_SECRET || '').trim();
    const refreshToken = (process.env.DRIVE_REFRESH_TOKEN || '').trim();
    const mainFolderId = (process.env.DRIVE_MAIN_FOLDER_ID || '').trim();

    const oauth2Client = new google.auth.OAuth2(
        clientId, 
        clientSecret, 
        "https://developers.google.com/oauthplayground"
    );
    oauth2Client.setCredentials({ refresh_token: refreshToken });
    const drive = google.drive({ version: 'v3', auth: oauth2Client });
    
    return { drive, mainFolderId };
};

// ✅ টেম্প ফাইল সেইফলি ডিলিট করার হেল্পার
const cleanupTempFile = (filePath) => {
    if (filePath) {
        fs.unlink(filePath, (err) => {
            if (err && err.code !== 'ENOENT') console.error('Temp file cleanup error:', err.message);
        });
    }
};

// ==============================================================
// ফাইল আপলোড API — ✅ Stream ব্যবহার করে (RAM ফুল হবে না)
// ==============================================================
router.post('/upload', upload.single('file'), async (req, res) => {
    const tempFilePath = req.file?.path;

    try {
        const file = req.file;
        const clientName = req.body.clientName || 'General_Clients';
        const projectName = req.body.projectName || 'Uncategorized_Files';

        if (!file) {
            return res.status(400).json({ error: "No file uploaded" });
        }

        // সিকিউর ভাবে চাবিগুলো নেওয়া হচ্ছে
        const { drive, mainFolderId } = getAuth();

        // অটোমেটিক ক্লায়েন্ট ও প্রজেক্ট ফোল্ডার তৈরি হবে
        const clientFolderId = await getOrCreateFolder(drive, clientName, mainFolderId);
        const projectFolderId = await getOrCreateFolder(drive, projectName, clientFolderId);

        // ✅ OOM Fix: Buffer এর বদলে সরাসরি fs.createReadStream ব্যবহার
        const fileStream = fs.createReadStream(tempFilePath);
        
        const response = await drive.files.create({
            requestBody: {
                name: file.originalname,
                parents: [projectFolderId],
                appProperties: { source: 'fortivus_agency' } // অটো-ডিলিট চেনার জন্য ট্যাগ
            },
            media: {
                mimeType: file.mimetype,
                body: fileStream  
            }
        }, {
            // ✅ Fix: বড় ফাইলের জন্য গুগল ড্রাইভের resumable upload সাপোর্ট অ্যাড করা হলো
            resumable: true
        });
        
        const fileUrl = `https://drive.google.com/file/d/${response.data.id}/view`;

        // ✅ আপলোড শেষে টেম্প ফাইল ডিলিট
        cleanupTempFile(tempFilePath);
        
        return res.status(200).json({
            message: "File uploaded successfully to Google Drive!",
            fileUrl: fileUrl
        });

    } catch (err) {
        console.error("Upload Error:", err);
        // এরর হলেও টেম্প ফাইল ক্লিনআপ
        cleanupTempFile(tempFilePath);
        res.status(500).json({ error: err.message });
    }
});

const parseGuidelineImageUpload = (req, res, next) => {
    guidelineImageUpload.single('file')(req, res, (error) => {
        if (!error) return next();

        cleanupTempFile(req.file?.path);
        const isTooLarge = error.code === 'LIMIT_FILE_SIZE';
        return res.status(isTooLarge ? 413 : 415).json({
            error: isTooLarge
                ? 'Guideline images cannot exceed 8 MB'
                : error.message
        });
    });
};

const readGuidelineImageMimeType = async (filePath) => {
    const handle = await fs.promises.open(filePath, 'r');
    try {
        const signature = Buffer.alloc(12);
        const { bytesRead } = await handle.read(signature, 0, signature.length, 0);
        return detectGuidelineImageMimeType(signature.subarray(0, bytesRead));
    } finally {
        await handle.close();
    }
};

// Guideline references are long-lived assets. They deliberately use a distinct
// source tag so the project-upload cleanup job below never removes them.
router.post(
    '/guideline-image',
    authenticate,
    requireAdmin,
    parseGuidelineImageUpload,
    async (req, res) => {
        const tempFilePath = req.file?.path;
        let uploadedFileId = '';
        let driveClient = null;

        try {
            if (!req.file) {
                return res.status(400).json({ error: 'No image uploaded' });
            }

            const detectedMimeType = await readGuidelineImageMimeType(tempFilePath);
            if (detectedMimeType !== String(req.file.mimetype || '').toLowerCase()) {
                cleanupTempFile(tempFilePath);
                return res.status(415).json({
                    error: 'Uploaded file content does not match its image type'
                });
            }

            const { drive, mainFolderId } = getAuth();
            driveClient = drive;
            const referenceName = normalizeGuidelineImageReferenceName(
                path.basename(req.file.originalname)
            );
            const guidelineFolderId = await getOrCreateFolder(
                drive,
                'Client_Guideline_References',
                mainFolderId
            );
            const fileStream = fs.createReadStream(tempFilePath);
            const response = await drive.files.create({
                requestBody: {
                    name: referenceName,
                    parents: [guidelineFolderId],
                    appProperties: { source: 'fortivus_guideline_reference' }
                },
                media: {
                    mimeType: req.file.mimetype,
                    body: fileStream
                },
                fields: 'id'
            });

            uploadedFileId = response.data.id;
            await drive.permissions.create({
                fileId: uploadedFileId,
                requestBody: { role: 'reader', type: 'anyone' }
            });

            cleanupTempFile(tempFilePath);
            return res.status(201).json({
                fileUrl: `https://drive.google.com/uc?export=view&id=${encodeURIComponent(uploadedFileId)}`,
                viewUrl: `https://drive.google.com/file/d/${encodeURIComponent(uploadedFileId)}/view`,
                referenceType: 'image',
                referenceName
            });
        } catch (err) {
            cleanupTempFile(tempFilePath);
            if (uploadedFileId && driveClient) {
                try {
                    await driveClient.files.delete({ fileId: uploadedFileId });
                } catch (cleanupError) {
                    console.error(
                        'Orphaned guideline image cleanup error:',
                        cleanupError.message
                    );
                }
            }
            console.error('Guideline image upload error:', err);
            return res.status(500).json({ error: 'Failed to upload guideline image' });
        }
    }
);

// ==============================================================
// ৯০ দিন পর অটো-ডিলিট হওয়ার সিস্টেম (প্রতিদিন রাত ১২টায় চেক করবে)
// ==============================================================
cron.schedule('0 0 * * *', async () => {
    console.log("Running 90-day auto-delete check...");
    try {
        const { drive } = getAuth();

        // ৯০ দিন আগের সময় বের করা
        const ninetyDaysAgo = new Date();
        ninetyDaysAgo.setDate(ninetyDaysAgo.getDate() - 90);
        const timeString = ninetyDaysAgo.toISOString();

        // শুধু আমাদের আপলোড করা ফাইল খুঁজবে যেগুলো ৯০ দিনের পুরনো
        const query = `appProperties has { key='source' and value='fortivus_agency' } and createdTime < '${timeString}' and trashed=false`;

        const res = await drive.files.list({
            q: query,
            fields: 'files(id, name)',
        });

        if (res.data.files.length > 0) {
            for (const f of res.data.files) {
                await drive.files.delete({ fileId: f.id });
                console.log(`Deleted 90-days old file: ${f.name}`);
            }
        } else {
            console.log("No files older than 90 days found.");
        }
    } catch (err) {
        console.error("Cron Job Error:", err);
    }
});

module.exports = router;
module.exports.GUIDELINE_IMAGE_MAX_BYTES = GUIDELINE_IMAGE_MAX_BYTES;
module.exports.GUIDELINE_IMAGE_MIME_TYPES = GUIDELINE_IMAGE_MIME_TYPES;
module.exports.detectGuidelineImageMimeType = detectGuidelineImageMimeType;
module.exports.isAllowedGuidelineImageMimeType = isAllowedGuidelineImageMimeType;
module.exports.normalizeGuidelineImageReferenceName = normalizeGuidelineImageReferenceName;
module.exports.parseGuidelineImageUpload = parseGuidelineImageUpload;
module.exports.readGuidelineImageMimeType = readGuidelineImageMimeType;
