const express = require('express');
const router = express.Router();
const Message = require('../models/Message');
const Room = require('../models/Room');

// ================== ROOM (Group/Private Chat) API ==================

// ইউজারের চ্যাট লিস্ট (রুম/গ্রুপ) তুলে আনার API
router.get('/rooms/:username', async (req, res) => {
    try {
        const username = req.params.username;
        // যে রুমে ইউজার মেম্বার হিসেবে আছে, সেগুলো খুঁজবে
        const rooms = await Room.find({ members: username });
        res.status(200).json(rooms);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// নতুন গ্রুপ বা প্রাইভেট চ্যাট (রুম) ক্রিয়েট করার API
router.post('/rooms', async (req, res) => {
    try {
        const { name, isGroup, members, createdBy } = req.body;
        
        // প্রাইভেট চ্যাট হলে আগে চেক করবো এই দুইজনের মাঝে কোনো রুম আছে কি না
        if (!isGroup) {
            const existingRoom = await Room.findOne({
                isGroup: false,
                members: { $all: members, $size: members.length } 
            });
            if (existingRoom) {
                return res.status(200).json(existingRoom); // থাকলে সেটাই রিটার্ন করবে
            }
        }

        const newRoom = new Room({
            name,
            isGroup,
            members,
            createdBy
        });
        
        const savedRoom = await newRoom.save();
        res.status(201).json(savedRoom);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ================== MESSAGE API ==================

// নির্দিষ্ট কোনো রুম বা গ্রুপের আগের সব মেসেজ তুলে আনার API
router.get('/:room', async (req, res) => {
    try {
        // Express যেন "rooms" শব্দটাকে :room হিসেবে না ধরে, তাই এটা নিচে রাখা হয়েছে
        if (req.params.room === 'rooms') return res.status(400).send('Invalid room id');

        const messages = await Message.find({ room: req.params.room }).sort({ createdAt: 1 });
        res.status(200).json(messages);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ডাটাবেসে নতুন মেসেজ সেভ করার API
router.post('/', async (req, res) => {
    try {
        const newMessage = new Message({
            room: req.body.room,
            sender: req.body.sender,
            text: req.body.text,
            fileUrl: req.body.fileUrl || '',
            time: req.body.time
        });
        
        const savedMessage = await newMessage.save();
        res.status(201).json(savedMessage);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

module.exports = router;