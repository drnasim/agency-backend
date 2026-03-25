const express = require('express');
const router = express.Router();
const Employee = require('../models/Employee');
const mongoose = require('mongoose');

// সব এডিটরদের লিস্ট দেখার API
router.get('/', async (req, res) => {
    try {
        const employees = await Employee.find().sort({ createdAt: -1 });
        res.status(200).json(employees);
    } catch (err) { 
        res.status(500).json({ error: err.message }); 
    }
});

// নতুন এডিটর অ্যাড করার API
router.post('/', async (req, res) => {
    try {
        const newEmployee = new Employee({
            name: req.body.name,
            email: req.body.email,
            position: req.body.position,
            salary: Number(req.body.salary) || 0 
        });
        
        const savedEmployee = await newEmployee.save();
        res.status(201).json(savedEmployee);
    } catch (err) { 
        res.status(500).json({ error: err.message }); 
    }
});

// এডিটরের ডিটেইলস ও পাসওয়ার্ড আপডেট করার API (নতুন যোগ করা হলো)
router.put('/:id', async (req, res) => {
    try {
        const { name, email, position, salary, password, oldEmail } = req.body;
        
        // ১. ড্যাশবোর্ডের Employee কালেকশন আপডেট
        const updatedEmployee = await Employee.findByIdAndUpdate(
            req.params.id, 
            { name, email, position, salary: Number(salary) || 0 }, 
            { new: true }
        );

        // ২. লগিন করার User/Auth কালেকশন আপডেট
        try {
            // আমরা ধরে নিচ্ছি আপনার অথেনটিকেশন মডেলের নাম 'User'
            const User = mongoose.models.User || mongoose.model('User');
            if (User) {
                let updateData = { name, email };
                
                // যদি অ্যাডমিন নতুন পাসওয়ার্ড দেয়, তাহলে সেটাও আপডেট হবে
                if (password && password.trim() !== '') {
                    updateData.password = password; 
                }

                await User.findOneAndUpdate({ email: oldEmail || email }, updateData);
            }
        } catch (authError) {
            console.log("Auth User update skipped. Make sure your Auth model is named 'User'.");
        }

        res.status(200).json(updatedEmployee);
    } catch (err) { 
        res.status(500).json({ error: err.message }); 
    }
});

// এডিটর ডিলিট করার API
router.delete('/:id', async (req, res) => {
    try {
        await Employee.findByIdAndDelete(req.params.id);
        res.status(200).json({ message: 'Employee deleted successfully' });
    } catch (err) { 
        res.status(500).json({ error: err.message }); 
    }
});

module.exports = router;