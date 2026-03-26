const express = require('express');
const router = express.Router();
const multer = require('multer');
const { google } = require('googleapis');
const stream = require('stream');

// মেমোরিতে ফাইল রাখার জন্য multer সেটআপ
const upload = multer({ storage: multer.memoryStorage() });

// ==============================================================
// হেল্পার ফাংশন: ড্রাইভে ফোল্ডার খোঁজা বা নতুন করে তৈরি করা
// ==============================================================
async function getOrCreateFolder(drive, folderName, parentFolderId) {
    try {
        const query = `mimeType='application/vnd.google-apps.folder' and name='${folderName}' and trashed=false ${parentFolderId ? `and '${parentFolderId}' in parents` : ''}`;
        
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
        
        const clientName = req.body.clientName || 'General_Clients';
        const projectName = req.body.projectName || 'Uncategorized_Files'; 

        if (!file) {
            return res.status(400).json({ error: "No file uploaded" });
        }

        // ==============================================================
        // Google Drive API রিয়েল আপলোড লজিক (Securely using process.env)
        // ==============================================================
        const oauth2Client = new google.auth.OAuth2(
            process.env.DRIVE_CLIENT_ID,
            process.env.DRIVE_CLIENT_SECRET,
            "https://developers.google.com/oauthplayground"
        );
        oauth2Client.setCredentials({ refresh_token: process.env.DRIVE_REFRESH_TOKEN });
        const drive = google.drive({ version: 'v3', auth: oauth2Client });

        const MAIN_ROOT_FOLDER_ID = process.env.DRIVE_MAIN_FOLDER_ID;

        const clientFolderId = await getOrCreateFolder(drive, clientName, MAIN_ROOT_FOLDER_ID);
        const projectFolderId = await getOrCreateFolder(drive, projectName, clientFolderId);

        const bufferStream = new stream.PassThrough();
        bufferStream.end(file.buffer);
        
        const response = await drive.files.create({
            requestBody: {
                name: file.originalname,
                parents: [projectFolderId] 
            },
            media: {
                mimeType: file.mimetype,
                body: bufferStream
            }
        });
        
        const fileUrl = `https://drive.google.com/file/d/${response.data.id}/view`;
        
        return res.status(200).json({ 
            message: "File uploaded successfully to Google Drive!", 
            fileUrl: fileUrl 
        });

    } catch (err) {
        console.error("Upload Error:", err);
        res.status(500).json({ error: err.message });
    }
});

module.exports = router;