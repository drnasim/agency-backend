const express = require('express');
const router = express.Router();
const Project = require('../models/Project');
const User = require('../models/User');

// ✅ Expo Push Notification পাঠানোর হেল্পার ফাংশন
const sendExpoPush = async (expoPushToken, title, body, data = {}) => {
    if (!expoPushToken || !expoPushToken.startsWith('ExponentPushToken')) {
        console.log('❌ Invalid Expo Token:', expoPushToken);
        return;
    }

    try {
        console.log(`🚀 Sending Mobile Push...`);
        const response = await fetch('https://exp.host/--/api/v2/push/send', {
            method: 'POST',
            headers: { 
                'Accept': 'application/json',
                'Content-Type': 'application/json' 
            },
            body: JSON.stringify({
                to: expoPushToken,
                title,
                body,
                sound: 'default',
                priority: 'high',
                channelId: 'project-alerts',  // ✅ Android notification channel — রিংটোন বাজবে
                data
            })
        });
        const result = await response.json();
        console.log('✅ Mobile Push Result:', result);
    } catch (err) {
        console.error('❌ Expo push error:', err.message);
    }
};

// সব প্রজেক্ট দেখার API
router.get('/', async (req, res) => {
    try {
        const projects = await Project.find().sort({ createdAt: -1 });
        res.status(200).json(projects);
    } catch (err) { 
        res.status(500).json({ error: err.message }); 
    }
});

// নির্দিষ্ট প্রজেক্টের ডিটেইলস দেখার API
router.get('/:id', async (req, res) => {
    try {
        const project = await Project.findById(req.params.id);
        res.status(200).json(project);
    } catch (err) { 
        res.status(500).json({ error: err.message }); 
    }
});

// নতুন প্রজেক্ট অ্যাড করার API
router.post('/', async (req, res) => {
    try {
        const newProject = new Project(req.body);
        const savedProject = await newProject.save();

        const assignedTo = savedProject.assignedTo || savedProject.assignedEditor;
        const createdBy = req.body.createdBy || '';

        // ================= Push Notification =================
        if (assignedTo) {
            // ✅ Self-Assignment Check: নিজে নিজেকে অ্যাসাইন করলে নোটিফিকেশন যাবে না
            if (createdBy && assignedTo === createdBy) {
                console.log(`Self-assignment detected (${createdBy}) — skipping notification`);
            } else {
                const notifTitle = 'New Project Assigned! 🚀';
                const notifBody = `You have been assigned to: ${savedProject.title || savedProject.projectName || 'a new project'}`;

                // ✅ ১. Web Push (Browser) — ক্র্যাশ ঠেকাতে সেফলি কল করা হলো
                if (global.sendPushNotification) {
                    try {
                        Promise.resolve(global.sendPushNotification(assignedTo, {
                            title: notifTitle,
                            body: notifBody
                        })).catch(e => console.log('⚠️ Web push skipped (FCM error), but Mobile push will continue.'));
                    } catch (e) {
                        console.log('⚠️ Web push skipped.');
                    }
                }

                // ✅ ২. Mobile Push (Expo/Android)
                try {
                    const editor = await User.findOne({
                        $or: [{ name: assignedTo }, { email: assignedTo }],
                        expoPushToken: { $exists: true, $ne: '' }
                    });

                    if (editor && editor.expoPushToken) {
                        await sendExpoPush(editor.expoPushToken, notifTitle, notifBody, {
                            projectId: savedProject._id.toString(),
                            type: 'new_project'
                        });
                    } else {
                        console.log(`⚠️ No Expo Push Token found for ${assignedTo}`);
                    }
                } catch (pushErr) {
                    console.log('❌ Mobile push lookup error:', pushErr.message);
                }
            }
        }

        res.status(201).json(savedProject);
    } catch (err) { 
        res.status(500).json({ error: err.message }); 
    }
});

// প্রজেক্ট আপডেট বা সাবমিট করার API (PATCH)
router.patch('/:id', async (req, res) => {
    try {
        const oldProject = await Project.findById(req.params.id);
        
        const updatedProject = await Project.findByIdAndUpdate(
            req.params.id, 
            { $set: req.body }, 
            { new: true }
        );
        
        if (!updatedProject) {
            return res.status(404).json({ error: "Project not found" });
        }

        // ================= Push Notification =================
        if (oldProject) {
            
            // হেল্পার ফাংশন — Web Push এবং Mobile Push একসাথে পাঠানোর জন্য
            const triggerNotifications = async (targetUser, title, body, type) => {
                // ১. Web Push
                if (global.sendPushNotification) {
                    try {
                        Promise.resolve(global.sendPushNotification(targetUser, { title, body }))
                            .catch(e => console.log('⚠️ Web push skipped.'));
                    } catch (e) {}
                }
                // ২. Mobile Push
                try {
                    const userDb = await User.findOne({
                        $or: [{ name: targetUser }, { email: targetUser }],
                        expoPushToken: { $exists: true, $ne: '' }
                    });
                    if (userDb?.expoPushToken) {
                        await sendExpoPush(userDb.expoPushToken, title, body, {
                            projectId: updatedProject._id.toString(),
                            type: type
                        });
                    } else {
                        console.log(`⚠️ No Expo Push Token found for ${targetUser}`);
                    }
                } catch (e) { /* silent */ }
            };

            // ১. এডিটর যদি কাজ জমা দেয় (Status changed to Submitted)
            if (req.body.status && req.body.status === 'Submitted' && oldProject.status !== 'Submitted') {
                if (updatedProject.createdBy) {
                    const title = 'Project Submitted! ✅';
                    const body = `${updatedProject.assignedTo || updatedProject.assignedEditor || 'Editor'} has submitted: ${updatedProject.title || updatedProject.projectName || ''}`;
                    await triggerNotifications(updatedProject.createdBy, title, body, 'project_submitted');
                }
            } 
            
            // ২. অ্যাডমিন যদি কারেকশন বা রিভিশন দেয়
            else if (req.body.status && req.body.status === 'Revision' && oldProject.status !== 'Revision') {
                const assignedTo = updatedProject.assignedTo || updatedProject.assignedEditor;
                if (assignedTo) {
                    const title = 'Revision Needed! ⚠️';
                    const body = `Admin requested revision for: ${updatedProject.title || updatedProject.projectName || ''}`;
                    await triggerNotifications(assignedTo, title, body, 'revision_needed');
                }
            }
            
            // ৩. অন্য কোনো আপডেট
            else if (req.body.updatedBy && req.body.updatedBy !== (updatedProject.assignedTo || updatedProject.assignedEditor)) {
                const assignedTo = updatedProject.assignedTo || updatedProject.assignedEditor;
                if (assignedTo) {
                    const title = 'Project Updated 📝';
                    const body = `Update on: ${updatedProject.title || updatedProject.projectName || ''}`;
                    await triggerNotifications(assignedTo, title, body, 'project_updated');
                }
            }
        }

        res.status(200).json(updatedProject);
    } catch (err) { 
        res.status(500).json({ error: err.message }); 
    }
});

// প্রজেক্ট ডিলিট করার API
router.delete('/:id', async (req, res) => {
    try {
        await Project.findByIdAndDelete(req.params.id);
        res.status(200).json({ message: 'Project deleted successfully' });
    } catch (err) { 
        res.status(500).json({ error: err.message }); 
    }
});

module.exports = router;