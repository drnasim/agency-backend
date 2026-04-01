const express = require('express');
const router = express.Router();
const Employee = require('../models/Employee');
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs'); // পাসওয়ার্ড সিকিউর করার জন্য

// সব ইউজারদের লিস্ট দেখার API
router.get('/', async (req, res) => {
    try {
        const employees = await Employee.find().sort({ createdAt: -1 });
        res.status(200).json(employees);
    } catch (err) { 
        res.status(500).json({ error: err.message }); 
    }
});

// নতুন ইউজার (এডিটর/অ্যাডমিন) অ্যাড করার API
router.post('/', async (req, res) => {
    try {
        const newEmployee = new Employee({
            name: req.body.name,
            email: req.body.email,
            position: req.body.position,
            salary: Number(req.body.salary) || 0,
            role: req.body.role || 'Editor' // রোল সেভ করা হচ্ছে
        });
        
        const savedEmployee = await newEmployee.save();
        res.status(201).json(savedEmployee);
    } catch (err) { 
        res.status(500).json({ error: err.message }); 
    }
});

// ইউজারের ডিটেইলস, রোল ও পাসওয়ার্ড আপডেট করার API
router.put('/:id', async (req, res) => {
    try {
        const { name, email, position, salary, password, oldEmail, role } = req.body;
        
        // ১. ড্যাশবোর্ডের Employee কালেকশন আপডেট (রোল সহ)
        const updatedEmployee = await Employee.findByIdAndUpdate(
            req.params.id, 
            { name, email, position, salary: Number(salary) || 0, role: role || 'Editor' }, 
            { new: true }
        );

        // ২. লগিন করার User/Auth কালেকশন আপডেট (যাতে লগিন করার সময় সঠিক অ্যাক্সেস পায়)
        try {
            // আমরা ধরে নিচ্ছি অথেনটিকেশন মডেলের নাম 'User'
            const User = mongoose.models.User || mongoose.model('User');
            if (User) {
                let updateData = { name, email, role: role || 'Editor' };
                
                // যদি অ্যাডমিন নতুন পাসওয়ার্ড দেয়, তাহলে সেটা হ্যাশ করে সেভ করতে হবে
                if (password && password.trim() !== '') {
                    const salt = await bcrypt.genSalt(10);
                    const hashedPassword = await bcrypt.hash(password, salt);
                    updateData.password = hashedPassword; // সিকিউর পাসওয়ার্ড সেভ হলো
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

// ইউজার ডিলিট করার API
router.delete('/:id', async (req, res) => {
    try {
        await Employee.findByIdAndDelete(req.params.id);
        res.status(200).json({ message: 'Employee deleted successfully' });
    } catch (err) { 
        res.status(500).json({ error: err.message }); 
    }
});

module.exports = router;