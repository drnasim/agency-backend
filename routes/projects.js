const express = require('express');
const router = express.Router();
const Project = require('../models/Project');
const { alarmUser } = require('../fcm');

// সব প্রজেক্ট দেখার API
router.get('/', async (req, res) => {
    try {
        const projects = await Project.find().sort({ createdAt: -1 });
        res.status(200).json(projects);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

router.get('/:id', async (req, res) => {
    try {
        const project = await Project.findById(req.params.id);
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

// প্রজেক্ট আপডেট — revision হলে editor-কে ring দাও
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
