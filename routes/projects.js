const express = require('express');
const router = express.Router();
const Project = require('../models/Project');
const { alarmUser } = require('../fcm');

// সব প্রজেক্ট দেখার API (পেজিনেশন ও মাল্টিপল ফিল্টার সাপোর্ট সহ)
router.get('/', async (req, res) => {
    try {
        const { page, limit, status, client, editor, projectType, paymentStatus, role } = req.query;

        // ডাইনামিক ফিল্টার কুয়েরি তৈরি করা হচ্ছে
        const queryObj = {};

        // ইউজারের রোল ছোট/বড় হাতের যাই হোক না কেন, সেটা চেক করার জন্য
        const isEditorRole = role && role.toLowerCase() === 'editor';

        // এডিটরদের জন্য স্পেশাল রুল: তারা শুধু নির্দিষ্ট স্ট্যাটাসের প্রজেক্ট দেখতে পারবে
        if (isEditorRole) {
            queryObj.status = { $in: ['Pending', 'In Progress', 'Under Review', 'Revision'] };
        } else if (status && status !== 'All') {
            // অ্যাডমিনদের জন্য নরমাল স্ট্যাটাস ফিল্টার
            queryObj.status = status;
        }
        
        if (client && client !== 'All') queryObj.client = client;
        if (projectType && projectType !== 'All') queryObj.projectType = projectType;
        if (paymentStatus && paymentStatus !== 'All') queryObj.paymentStatus = paymentStatus;
        
        // এডিটর ফিল্টারের জন্য স্পেশাল লজিক, কারণ ডাটাবেসে কয়েকটা নামে সেভ থাকতে পারে
        if (editor && editor !== 'All') {
            queryObj.$or = [
                { assignedEditor: editor },
                { editor: editor },
                { assignedTo: editor }
            ];
        }

        // যদি ফ্রন্টএন্ড থেকে page এবং limit না পাঠানো হয় (যাতে ফাইন্যান্স পেজ ঠিক থাকে)
        if (!page || !limit) {
            const projects = await Project.find(queryObj).sort({ createdAt: -1 }).lean();
            
            // ফ্রন্টএন্ডের জন্য এডিটর ফিল্ড ম্যাপ করা হচ্ছে
            const formattedProjects = projects.map(project => ({
                ...project,
                editor: project.editor || project.assignedTo || project.assignedEditor || 'Unassigned'
            }));

            return res.status(200).json(formattedProjects);
        }

        // যদি page এবং limit পাঠানো হয়, তবে ব্যাকএন্ড পেজিনেশন কাজ করবে
        const pageNumber = parseInt(page);
        const limitNumber = parseInt(limit);
        const skip = (pageNumber - 1) * limitNumber;

        // ফিল্টার অনুযায়ী ডাটাবেস থেকে নির্দিষ্ট লিমিটের ডাটা এবং মোট সংখ্যা বের করা
        const totalProjects = await Project.countDocuments(queryObj);
        const projects = await Project.find(queryObj)
            .sort({ createdAt: -1 })
            .skip(skip)
            .limit(limitNumber)
            .lean();

        const formattedProjects = projects.map(project => ({
            ...project,
            editor: project.editor || project.assignedTo || project.assignedEditor || 'Unassigned'
        }));

        res.status(200).json({
            projects: formattedProjects,
            totalProjects,
            totalPages: Math.ceil(totalProjects / limitNumber),
            currentPage: pageNumber
        });

    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

router.get('/:id', async (req, res) => {
    try {
        const project = await Project.findById(req.params.id).lean();
        
        if (project) {
            project.editor = project.editor || project.assignedTo || project.assignedEditor || 'Unassigned';
        }

        res.status(200).json(project);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// নতুন প্রজেক্ট — editor-কে ring দাও
router.post('/', async (req, res) => {
    try {
        const newProject = new Project(req.body);
        const savedProject = await newProject.save();

        const assignedTo = savedProject.assignedTo || savedProject.assignedEditor;
        const createdBy = req.body.createdBy || '';

        if (assignedTo && !(createdBy && assignedTo === createdBy)) {
            const title = 'New Project Assigned';
            const body = `${savedProject.title || savedProject.projectName || 'A new project'} has been assigned to you.`;

            // Browser (web-push)
            if (global.sendPushNotification) {
                global.sendPushNotification(assignedTo, { title, body });
            }

            // Mobile (FCM data-only → full-screen alarm)
            await alarmUser(assignedTo, title, body, {
                projectId: savedProject._id.toString(),
                type: 'new_project',
            });
        }

        res.status(201).json(savedProject);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// প্রজেক্ট আপডেট (PUT) — Frontend থেকে Quick Editor চেঞ্জ বা ফুল আপডেটের জন্য
router.put('/:id', async (req, res) => {
    try {
        const oldProject = await Project.findById(req.params.id);
        
        const updatedProject = await Project.findByIdAndUpdate(
            req.params.id,
            { $set: req.body },
            { new: true }
        );

        if (!updatedProject) return res.status(404).json({ error: 'Project not found' });

        // যদি লিস্ট থেকে এডিটর পরিবর্তন করা হয়, তবে নতুন এডিটরকে নোটিফিকেশন পাঠাবে
        if (oldProject) {
            const oldEditor = oldProject.assignedTo || oldProject.assignedEditor;
            const newEditor = updatedProject.assignedTo || updatedProject.assignedEditor;

            // এডিটর চেঞ্জ হয়েছে কিনা চেক করা হচ্ছে
            if (newEditor && String(oldEditor) !== String(newEditor)) {
                const title = 'Project Re-assigned';
                const body = `${updatedProject.title || updatedProject.projectName || 'A project'} has been re-assigned to you.`;

                if (global.sendPushNotification) {
                    global.sendPushNotification(newEditor, { title, body });
                }

                await alarmUser(newEditor, title, body, {
                    projectId: updatedProject._id.toString(),
                    type: 'new_project',
                });
            }
        }

        res.status(200).json(updatedProject);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// প্রজেক্ট আপডেট (PATCH) — revision হলে editor-কে ring দাও
router.patch('/:id', async (req, res) => {
    try {
        const oldProject = await Project.findById(req.params.id);

        const updatedProject = await Project.findByIdAndUpdate(
            req.params.id,
            { $set: req.body },
            { new: true }
        );

        if (!updatedProject) return res.status(404).json({ error: 'Project not found' });
        if (!oldProject) return res.status(200).json(updatedProject);

        const projName = updatedProject.title || updatedProject.projectName || '';
        const assignedTo = updatedProject.assignedTo || updatedProject.assignedEditor;

        // 1. Editor submitted → notify admin (browser only, admin usually on desktop)
        if (req.body.status === 'Submitted' && oldProject.status !== 'Submitted') {
            if (updatedProject.createdBy && global.sendPushNotification) {
                global.sendPushNotification(updatedProject.createdBy, {
                    title: 'Project Submitted',
                    body: `${assignedTo || 'Editor'} submitted: ${projName}`,
                });
            }
        }
        // 2. Admin requested revision → RING THE EDITOR
        else if (req.body.status === 'Revision' && oldProject.status !== 'Revision') {
            if (assignedTo) {
                const title = 'Revision Needed';
                const body = `Admin requested revision for: ${projName}`;

                if (global.sendPushNotification) {
                    global.sendPushNotification(assignedTo, { title, body });
                }

                await alarmUser(assignedTo, title, body, {
                    projectId: updatedProject._id.toString(),
                    type: 'revision_needed',
                });
            }
        }

        res.status(200).json(updatedProject);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

router.delete('/:id', async (req, res) => {
    try {
        await Project.findByIdAndDelete(req.params.id);
        res.status(200).json({ message: 'Project deleted successfully' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

module.exports = router;