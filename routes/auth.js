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

        // ২. ফোন নাম্বার ডুপ্লিকেট চেক (যদি দিয়ে থাকে)
        if (req.body.phone && req.body.phone.trim() !== "") {
            const existingPhone = await User.findOne({ phone: req.body.phone });
            if (existingPhone) {
                return res.status(400).json({ error: "এই ফোন নাম্বারটি অলরেডি অন্য কারো আইডিতে দেওয়া আছে!" });
            }
        }

        const salt = await bcrypt.genSalt(10);
        const hashedPassword = await bcrypt.hash(req.body.password, salt);

        // ✅ role সবসময় array হিসেবে সেভ হবে
        let roleArray = req.body.role;
        if (!roleArray) {
            roleArray = ['Editor'];
        } else if (typeof roleArray === 'string') {
            roleArray = [roleArray];
        }
        
        const newUser = new User({
            name: req.body.name,
            email: req.body.email,
            password: hashedPassword,
            role: roleArray,
            ...(req.body.phone && req.body.phone.trim() !== "" ? { phone: req.body.phone } : {})
        });
        
        const savedUser = await newUser.save();
        res.status(201).json(savedUser);
    } catch (err) {
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

        // অ্যাডমিন অ্যাকাউন্ট না থাকলে ফার্স্ট টাইমের জন্য তৈরি করবে
        if (!user && req.body.email === 'admin@agency.com' && (req.body.password === 'admin123' || req.body.password === 'password123')) {
            const salt = await bcrypt.genSalt(10);
            const hashed = await bcrypt.hash(req.body.password, salt);
            user = new User({ 
                name: 'MD NASIM SARKER', 
                email: 'admin@agency.com', 
                password: hashed, 
                role: ['Admin'],
                gender: 'Male'
            });
            await user.save();

            return res.status(200).json({ 
                name: user.name, 
                email: user.email, 
                role: user.role,        // ✅ array রিটার্ন
                primaryRole: 'Admin'    // ✅ প্রাইমারি রোল আলাদা
            });
        }

        if (!user) return res.status(404).json({ error: "User not found in database!" });
        // ডিলিট/ডিজেবল করা অ্যাকাউন্ট ব্লক করা হচ্ছে
        if (user.isActive === false) return res.status(403).json({ error: "This account has been deactivated. Please contact admin." });
        if (!user.password) return res.status(400).json({ error: "Password is not set for this account." });

        const validPass = await bcrypt.compare(req.body.password, user.password);
        if (!validPass) return res.status(400).json({ error: "Wrong password!" });

        // ✅ role array নিশ্চিত করা (পুরনো স্ট্রিং ডেটার জন্য backward compatibility)
        const roleArray = Array.isArray(user.role) ? user.role : [user.role];

        // ✅ primaryRole: Admin > Marketer > Editor priority
        const primaryRole = roleArray.includes('Admin') ? 'Admin' : roleArray.includes('Marketer') ? 'Marketer' : 'Editor';

        res.status(200).json({ 
            name: user.name, 
            email: user.email, 
            role: roleArray,        // ✅ array রিটার্ন (সব রোল)
            primaryRole: primaryRole // ✅ প্রাইমারি রোল (নেভিগেশন কন্ট্রোলের জন্য)
        });
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
        if (user.isActive === false) return res.status(403).json({ error: "Account deactivated" });

        // ✅ role array নিশ্চিত করা
        const roleArray = Array.isArray(user.role) ? user.role : [user.role];

        res.status(200).json({ ...user.toObject(), role: roleArray });
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

        // আপডেট করার সময় ফোন নাম্বার ইউনিক কি না সেটা চেক করা
        if (phone && phone.trim() !== "" && phone !== user.phone) {
            const existingPhone = await User.findOne({ phone: phone });
            if (existingPhone) {
                return res.status(400).json({ error: "এই ফোন নাম্বারটি অলরেডি অন্য একজন ব্যবহার করছে!" });
            }
        }

        if (name !== undefined) user.name = name;
        if (phone !== undefined) user.phone = phone;
        if (dob !== undefined) user.dob = dob;
        if (gender !== undefined) user.gender = gender;
        if (profilePic !== undefined && profilePic !== "") user.profilePic = profilePic;
        
        if (newPassword && newPassword.trim() !== "") {
            const salt = await bcrypt.genSalt(10);
            user.password = await bcrypt.hash(newPassword, salt);
        }

        const updatedUser = await user.save();

        // ✅ role array নিশ্চিত করা
        const roleArray = Array.isArray(updatedUser.role) ? updatedUser.role : [updatedUser.role];
        const primaryRole = roleArray.includes('Admin') ? 'Admin' : roleArray.includes('Marketer') ? 'Marketer' : 'Editor';

        res.status(200).json({ 
            message: "Profile updated successfully!", 
            name: updatedUser.name, 
            email: updatedUser.email, 
            role: roleArray,
            primaryRole: primaryRole,
            profilePic: updatedUser.profilePic 
        });
    } catch (err) {
        console.error("Update Error:", err);
        if (err.code === 11000) {
            return res.status(400).json({ error: "এই ইমেইল বা ফোন নাম্বার অলরেডি ব্যবহার করা হচ্ছে!" });
        }
        res.status(500).json({ error: err.message });
    }
});

// সব ইউজার বা নির্দিষ্ট রোলের ইউজার লিস্ট পাওয়ার API
router.get('/users', async (req, res) => {
    try {
        const { role } = req.query;
        let users;
        if (role) {
            users = await User.find({ role: role }).select('name email role');
        } else {
            users = await User.find({}).select('name email role');
        }
        res.json(users);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ✅ মোবাইল অ্যাপ থেকে Expo Push Token সেভ করার API
// অ্যাপে লগিন করার পর এই endpoint এ token পাঠানো হবে
router.post('/push-token', async (req, res) => {
    try {
        const { email, expoPushToken } = req.body;
        if (!email || !expoPushToken) {
            return res.status(400).json({ error: 'email and expoPushToken are required' });
        }

        const user = await User.findOneAndUpdate(
            { email },
            { expoPushToken },
            { new: true }
        );

        if (!user) return res.status(404).json({ error: 'User not found' });

        res.status(200).json({ message: 'Push token saved successfully', name: user.name });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

module.exports = router;