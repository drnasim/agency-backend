const express = require('express');
const router = express.Router();
const Project = require('../models/Project');
const User = require('../models/User');

// ✅ Expo Push Notification পাঠানোর হেল্পার ফাংশন
// Expo Push API ব্যবহার করে — কোনো API key লাগে না, শুধু ইউজারের push token দরকার
const sendExpoPush = async (expoPushToken, title, body, data = {}) => {
    if (!expoPushToken || !expoPushToken.startsWith('ExponentPushToken')) return;

    try {
        await fetch('https://exp.host/--/api/v2/push/send', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
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
    } catch (err) {
        console.error('Expo push error:', err.message);
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

// নতুন প্রজেক্ট অ্যাড করার API — ✅ Expo Push + Self-assignment check
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

                // ✅ ১. Web Push (Browser) — আগের সিস্টেম, এখনো কাজ করবে
                if (global.sendPushNotification) {
                    global.sendPushNotification(assignedTo, {
                        title: notifTitle,
                        body: notifBody
                    });
                }

                // ✅ ২. Mobile Push (Expo/Android) — নতুন সিস্টেম
                // Editor এর email দিয়ে তার Expo push token খুঁজে নোটিফিকেশন পাঠানো
                try {
                    // assignedTo নাম বা ইমেইল হতে পারে — দুইটাই চেক
                    const editor = await User.findOne({
                        $or: [{ name: assignedTo }, { email: assignedTo }],
                        expoPushToken: { $ne: '' }
                    });

                    if (editor && editor.expoPushToken) {
                        await sendExpoPush(editor.expoPushToken, notifTitle, notifBody, {
                            projectId: savedProject._id.toString(),
                            type: 'new_project'
                        });
                        console.log(`📱 Mobile push sent to ${editor.name}`);
                    }
                } catch (pushErr) {
                    console.log('Mobile push lookup error:', pushErr.message);
                }
            }
        }

        res.status(201).json(savedProject);
    } catch (err) { 
        res.status(500).json({ error: err.message }); 
    }
});

// প্রজেক্ট আপডেট বা সাবমিট করার API (PATCH) — ✅ Expo Push যোগ
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
        if (oldProject && global.sendPushNotification) {
            
            // ১. এডিটর যদি কাজ জমা দেয় (Status changed to Submitted)
            if (req.body.status && req.body.status === 'Submitted' && oldProject.status !== 'Submitted') {
                if (updatedProject.createdBy) {
                    const notifTitle = 'Project Submitted! ✅';
                    const notifBody = `${updatedProject.assignedTo || updatedProject.assignedEditor || 'Editor'} has submitted: ${updatedProject.title || updatedProject.projectName || ''}`;

                    global.sendPushNotification(updatedProject.createdBy, { title: notifTitle, body: notifBody });

                    // ✅ Mobile push to admin/creator
                    try {
                        const creator = await User.findOne({
                            $or: [{ name: updatedProject.createdBy }, { email: updatedProject.createdBy }],
                            expoPushToken: { $ne: '' }
                        });
                        if (creator?.expoPushToken) {
                            await sendExpoPush(creator.expoPushToken, notifTitle, notifBody, {
                                projectId: updatedProject._id.toString(),
                                type: 'project_submitted'
                            });
                        }
                    } catch (e) { /* silent */ }
                }
            } 
            
            // ২. অ্যাডমিন যদি কারেকশন বা রিভিশন দেয়
            else if (req.body.status && req.body.status === 'Revision' && oldProject.status !== 'Revision') {
                const assignedTo = updatedProject.assignedTo || updatedProject.assignedEditor;
                if (assignedTo) {
                    const notifTitle = 'Revision Needed! ⚠️';
                    const notifBody = `Admin requested revision for: ${updatedProject.title || updatedProject.projectName || ''}`;

                    global.sendPushNotification(assignedTo, { title: notifTitle, body: notifBody });

                    // ✅ Mobile push to editor
                    try {
                        const editor = await User.findOne({
                            $or: [{ name: assignedTo }, { email: assignedTo }],
                            expoPushToken: { $ne: '' }
                        });
                        if (editor?.expoPushToken) {
                            await sendExpoPush(editor.expoPushToken, notifTitle, notifBody, {
                                projectId: updatedProject._id.toString(),
                                type: 'revision_needed'
                            });
                        }
                    } catch (e) { /* silent */ }
                }
            }
            
            // ৩. অন্য কোনো আপডেট
            else if (req.body.updatedBy && req.body.updatedBy !== (updatedProject.assignedTo || updatedProject.assignedEditor)) {
                const assignedTo = updatedProject.assignedTo || updatedProject.assignedEditor;
                if (assignedTo) {
                    const notifTitle = 'Project Updated 📝';
                    const notifBody = `Update on: ${updatedProject.title || updatedProject.projectName || ''}`;

                    global.sendPushNotification(assignedTo, { title: notifTitle, body: notifBody });

                    try {
                        const editor = await User.findOne({
                            $or: [{ name: assignedTo }, { email: assignedTo }],
                            expoPushToken: { $ne: '' }
                        });
                        if (editor?.expoPushToken) {
                            await sendExpoPush(editor.expoPushToken, notifTitle, notifBody, {
                                projectId: updatedProject._id.toString(),
                                type: 'project_updated'
                            });
                        }
                    } catch (e) { /* silent */ }
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