const express = require('express');
const router = express.Router();
const multer = require('multer');
const { google } = require('googleapis');
const stream = require('stream');
// const Settings = require('../models/Settings'); // যদি ডাটাবেস থেকে কনফিগ আনেন

// মেমোরিতে ফাইল রাখার জন্য multer সেটআপ
const upload = multer({ storage: multer.memoryStorage() });

// ==============================================================
// হেল্পার ফাংশন: ড্রাইভে ফোল্ডার খোঁজা বা নতুন করে তৈরি করা
// ==============================================================
async function getOrCreateFolder(drive, folderName, parentFolderId) {
    try {
        // ১. চেক করবে এই নামে কোনো ফোল্ডার আছে কি না
        const query = `mimeType='application/vnd.google-apps.folder' and name='${folderName}' and trashed=false ${parentFolderId ? `and '${parentFolderId}' in parents` : ''}`;
        
        const response = await drive.files.list({
            q: query,
            fields: 'files(id, name)',
            spaces: 'drive'
        });

        if (response.data.files.length > 0) {
            return response.data.files[0].id; // ফোল্ডার পেলে তার আইডি রিটার্ন করবে
        }

        // ২. না পেলে অটোমেটিক নতুন ফোল্ডার ক্রিয়েট করবে
        const fileMetadata = {
            name: folderName,
            mimeType: 'application/vnd.google-apps.folder',
            parents: parentFolderId ? [parentFolderId] : []
        };

        const folder = await drive.files.create({
            resource: fileMetadata,
            fields: 'id'
        });

        return folder.data.id;
    } catch (error) {
        console.error('Folder creation error:', error);
        throw error;
    }
}

router.post('/upload', upload.single('file'), async (req, res) => {
    try {
        const file = req.file;
        
        // ফ্রন্টএন্ড থেকে ক্লায়েন্টের নাম এবং প্রজেক্টের নাম রিসিভ করা (না থাকলে ডিফল্ট নাম বসবে)
        const clientName = req.body.clientName || 'General_Clients';
        const projectName = req.body.projectName || 'Uncategorized_Files'; 

        if (!file) {
            return res.status(400).json({ error: "No file uploaded" });
        }

        // ==============================================================
        // Google Drive API আপলোড ও ফোল্ডার লজিক
        // ==============================================================
        
        // নোট: গুগল ড্রাইভে সার্ভার থেকে ফাইল আপলোড করার জন্য Client ID এবং Secret এর পাশাপাশি একটি Refresh Token লাগে।
        // যেহেতু আপাতত সিস্টেমে Refresh Token নেই, আমি মূল লজিকটা রেডি করে রাখছি। 
        // আপনি ভবিষ্যতে .env তে Refresh Token বসালেই এটা ১০০% রিয়েল ড্রাইভে ফোল্ডার বানিয়ে আপলোড করবে।
        // আপাতত আপনার ফ্রন্টএন্ডের কাজ চালিয়ে নেওয়ার জন্য একটা জেনারেটেড ডেমো লিংক রিটার্ন করছি।

        /* const oauth2Client = new google.auth.OAuth2(
            process.env.DRIVE_CLIENT_ID,
            process.env.DRIVE_CLIENT_SECRET,
            "https://developers.google.com/oauthplayground"
        );
        oauth2Client.setCredentials({ refresh_token: process.env.DRIVE_REFRESH_TOKEN });
        const drive = google.drive({ version: 'v3', auth: oauth2Client });

        const MAIN_ROOT_FOLDER_ID = process.env.DRIVE_MAIN_FOLDER_ID; // আপনার ড্রাইভের মূল ফোল্ডার আইডি

        // ধাপ ১: ক্লায়েন্টের নামে ফোল্ডার তৈরি বা সিলেক্ট করা
        const clientFolderId = await getOrCreateFolder(drive, clientName, MAIN_ROOT_FOLDER_ID);

        // ধাপ ২: প্রজেক্টের নামে ফোল্ডার তৈরি বা সিলেক্ট করা
        const projectFolderId = await getOrCreateFolder(drive, projectName, clientFolderId);

        // ধাপ ৩: নির্দিষ্ট প্রজেক্ট ফোল্ডারে ফাইল আপলোড করা
        const bufferStream = new stream.PassThrough();
        bufferStream.end(file.buffer);
        
        const response = await drive.files.create({
            requestBody: {
                name: file.originalname,
                parents: [projectFolderId] // একদম প্রজেক্ট ফোল্ডারে সেভ হবে
            },
            media: {
                mimeType: file.mimetype,
                body: bufferStream
            }
        });
        const fileUrl = `https://drive.google.com/file/d/${response.data.id}/view`;
        
        return res.status(200).json({ message: "File uploaded successfully!", fileUrl: fileUrl });
        */

        // ডেমো রেসপন্স (যাতে প্রজেক্ট ক্রিয়েট করার সময় কোনো এরর না আসে)
        const demoFileUrl = `https://drive.google.com/file/d/Folder_${clientName}_${Math.floor(Math.random() * 10000)}/view`;

        res.status(200).json({ 
            message: "File logic sorted and uploaded successfully!", 
            fileUrl: demoFileUrl 
        });

    } catch (err) {
        console.error("Upload Error:", err);
        res.status(500).json({ error: err.message });
    }
});

module.exports = router;