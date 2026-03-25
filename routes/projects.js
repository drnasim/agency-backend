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
        res.status(201).json(savedProject);
    } catch (err) { 
        res.status(500).json({ error: err.message }); 
    }
});

// প্রজেক্ট আপডেট বা সাবমিট করার API (PATCH)
router.patch('/:id', async (req, res) => {
    try {
        const updatedProject = await Project.findByIdAndUpdate(
            req.params.id, 
            { $set: req.body }, 
            { new: true }
        );
        
        if (!updatedProject) {
            return res.status(404).json({ error: "Project not found" });
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