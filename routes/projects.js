const express = require('express');
const router = express.Router();
const Project = require('../models/Project');

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

        // ================= Push Notification =================
        // প্রজেক্ট যাকে অ্যাসাইন করা হয়েছে (Editor), শুধু তাকেই নোটিফিকেশন পাঠানো হবে
        if (savedProject.assignedTo && global.sendPushNotification) {
            global.sendPushNotification(savedProject.assignedTo, {
                title: 'New Project Assigned! 🚀',
                body: `You have been assigned to: ${savedProject.projectName || 'a new project'}`
            });
        }

        res.status(201).json(savedProject);
    } catch (err) { 
        res.status(500).json({ error: err.message }); 
    }
});

// প্রজেক্ট আপডেট বা সাবমিট করার API (PATCH)
router.patch('/:id', async (req, res) => {
    try {
        // আপডেট করার আগে পুরনো ডাটা তুলে নিচ্ছি, যাতে কী পরিবর্তন হলো সেটা বুঝতে পারি
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
                // অ্যাডমিনকে (যিনি প্রজেক্ট তৈরি করেছেন) নোটিফিকেশন পাঠাবো
                if (updatedProject.createdBy) {
                    global.sendPushNotification(updatedProject.createdBy, {
                        title: 'Project Submitted! ✅',
                        body: `${updatedProject.assignedTo || 'Editor'} has submitted the project: ${updatedProject.projectName || ''}`
                    });
                }
            } 
            
            // ২. অ্যাডমিন যদি কারেকশন বা রিভিশন দেয় (Status changed to Revision)
            else if (req.body.status && req.body.status === 'Revision' && oldProject.status !== 'Revision') {
                // শুধু নির্দিষ্ট এডিটরকে জানাবো
                if (updatedProject.assignedTo) {
                    global.sendPushNotification(updatedProject.assignedTo, {
                        title: 'Revision Needed! ⚠️',
                        body: `Admin requested a revision for your project: ${updatedProject.projectName || ''}`
                    });
                }
            }
            
            // ৩. প্রজেক্টে যদি অন্য কোনো আপডেট আসে (যেমন কারেকশন নোট অ্যাড করা হলো)
            // ফ্রন্টএন্ড থেকে যদি updatedBy পাঠানো হয় এবং সে যদি এডিটর না হয়, তাহলে এডিটরকে নোটিফিকেশন দেব
            else if (req.body.updatedBy && req.body.updatedBy !== updatedProject.assignedTo) {
                 global.sendPushNotification(updatedProject.assignedTo, {
                     title: 'Project Updated 📝',
                     body: `New update or correction added to your project: ${updatedProject.projectName || ''}`
                 });
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