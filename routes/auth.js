const express = require('express');
const router = express.Router();
const User = require('../models/User');
const bcrypt = require('bcryptjs'); 

// নতুন ইউজার/এডিটর রেজিস্টার করার API
router.post('/register', async (req, res) => {
    try {
        // ১. ইমেইল ডুপ্লিকেট চেক
        const existingEmail = await User.findOne({ email: req.body.email });
        if (existingEmail) {
            return res.status(400).json({ error: "এই ইমেইলটি অলরেডি অন্য আইডিতে ব্যবহার করা হচ্ছে!" });
        }

        // ২. ফোন নাম্বার ডুপ্লিকেট চেক (যদি দিয়ে থাকে)
        if (req.body.phone) {
            const existingPhone = await User.findOne({ phone: req.body.phone });
            if (existingPhone) {
                return res.status(400).json({ error: "এই ফোন নাম্বারটি অলরেডি অন্য কারো আইডিতে দেওয়া আছে!" });
            }
        }

        const salt = await bcrypt.genSalt(10);
        const hashedPassword = await bcrypt.hash(req.body.password, salt);
        
        const newUser = new User({
            name: req.body.name,
            email: req.body.email,
            password: hashedPassword,
            role: req.body.role || 'Editor',
            phone: req.body.phone || ''
        });
        
        const savedUser = await newUser.save();
        res.status(201).json(savedUser);
    } catch (err) {
        // ডাটাবেস লেভেলের ডুপ্লিকেট এরর হ্যান্ডেলিং
        if (err.code === 11000) {
            return res.status(400).json({ error: "এই ইমেইল বা ফোন নাম্বার অলরেডি ব্যবহার করা হচ্ছে!" });
        }
        res.status(500).json({ error: err.message });
    }
});

// লগিন করার API
router.post('/login', async (req, res) => {
    try {
        let user = await User.findOne({ email: req.body.email });

        // সুপার অ্যাডমিন লগিন বাইপাস এবং ডাটাবেসে সেভ করা (যাতে প্রোফাইল এডিট করা যায়)
        if (req.body.email === 'admin@agency.com' && (req.body.password === 'admin123' || req.body.password === 'password123')) {
            if (!user) {
                const salt = await bcrypt.genSalt(10);
                const hashed = await bcrypt.hash('admin123', salt);
                user = new User({ 
                    name: 'MD NASIM SARKER', 
                    email: 'admin@agency.com', 
                    password: hashed, 
                    role: 'Admin',
                    gender: 'Male'
                });
                await user.save();
            }
            return res.status(200).json({ name: user.name, email: user.email, role: user.role });
        }

        if (!user) return res.status(404).json({ error: "User not found in database!" });
        if (!user.password) return res.status(400).json({ error: "Password is not set for this account." });

        const validPass = await bcrypt.compare(req.body.password, user.password);
        if (!validPass) return res.status(400).json({ error: "Wrong password!" });

        res.status(200).json({ name: user.name, email: user.email, role: user.role });
    } catch (err) {
        console.error("Login Error:", err);
        res.status(500).json({ error: err.message });
    }
});

// ইউজারের কারেন্ট প্রোফাইল ডেটা পাওয়ার API
router.get('/me', async (req, res) => {
    try {
        const email = req.query.email;
        const user = await User.findOne({ email });
        if (!user) return res.status(404).json({ error: "User not found" });
        res.status(200).json(user);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// প্রোফাইল আপডেট করার API
router.put('/update', async (req, res) => {
    try {
        const { currentEmail, name, newPassword, phone, dob, gender, profilePic } = req.body;
        
        const user = await User.findOne({ email: currentEmail });
        if (!user) return res.status(404).json({ error: "User not found!" });

        // আপডেট করার সময় ফোন নাম্বার ইউনিক কি না সেটা চেক করা
        if (phone && phone !== user.phone) {
            const existingPhone = await User.findOne({ phone: phone });
            if (existingPhone) {
                return res.status(400).json({ error: "এই ফোন নাম্বারটি অলরেডি অন্য একজন ব্যবহার করছে!" });
            }
        }

        // সব ডেটা আপডেট
        if (name !== undefined) user.name = name;
        if (phone !== undefined) user.phone = phone;
        if (dob !== undefined) user.dob = dob;
        if (gender !== undefined) user.gender = gender;
        if (profilePic !== undefined) user.profilePic = profilePic;
        
        if (newPassword) {
            const salt = await bcrypt.genSalt(10);
            user.password = await bcrypt.hash(newPassword, salt);
        }

        const updatedUser = await user.save();
        res.status(200).json({ message: "Profile updated successfully!", name: updatedUser.name, email: updatedUser.email, role: updatedUser.role });
    } catch (err) {
        console.error("Update Error:", err);
        if (err.code === 11000) {
            return res.status(400).json({ error: "এই ইমেইল বা ফোন নাম্বার অলরেডি ব্যবহার করা হচ্ছে!" });
        }
        res.status(500).json({ error: err.message });
    }
});

module.exports = router;