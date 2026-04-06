const express = require('express');
const router = express.Router();
const Message = require('../models/Message');
const Room = require('../models/Room');

// ================== ROOM (Group/Private Chat) API ==================

// ইউজারের চ্যাট লিস্ট (রুম/গ্রুপ) তুলে আনার API
router.get('/rooms/:username', async (req, res) => {
    try {
        const username = req.params.username;
        const rooms = await Room.find({ members: username });
        res.status(200).json(rooms);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// নতুন গ্রুপ বা প্রাইভেট চ্যাট (রুম) ক্রিয়েট করার API
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
                return res.status(200).json(existingRoom);
            }
        }

        const newRoom = new Room({ name, isGroup, members, createdBy });
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
        if (req.params.room === 'rooms') return res.status(400).send('Invalid room id');

        const messages = await Message.find({ room: req.params.room }).sort({ createdAt: 1 });
        res.status(200).json(messages);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ডাটাবেসে নতুন মেসেজ সেভ করার API — ✅ status tracking সহ
router.post('/', async (req, res) => {
    try {
        const newMessage = new Message({
            room: req.body.room,
            sender: req.body.sender,
            text: req.body.text,
            fileUrl: req.body.fileUrl || '',
            time: req.body.time,
            status: 'sent',
            deliveredTo: [],
            readBy: [req.body.sender] // নিজে তো নিজের মেসেজ দেখেছে
        });

        const savedMessage = await newMessage.save();

        // ================= Push Notification Logic =================
        if (global.sendPushNotification) {
            const roomData = await Room.findById(req.body.room);
            if (roomData && roomData.members) {
                let previewText = req.body.text
                    ? (req.body.text.length > 30 ? req.body.text.substring(0, 30) + '...' : req.body.text)
                    : 'Sent a file/attachment 📎';

                roomData.members.forEach(member => {
                    if (member !== req.body.sender) {
                        global.sendPushNotification(member, {
                            title: roomData.isGroup ? `New message in ${roomData.name} 💬` : `New message from ${req.body.sender}`,
                            body: roomData.isGroup ? `${req.body.sender}: ${previewText}` : previewText
                        });
                    }
                });
            }
        }

        res.status(201).json(savedMessage);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ================== ✅ UNREAD COUNT API ==================
// একটি ইউজারের সব রুমের unread message count বের করার API
router.get('/unread/:username', async (req, res) => {
    try {
        const username = req.params.username;

        // ইউজার যে রুমগুলোতে আছে সেগুলো বের করা
        const rooms = await Room.find({ members: username });
        const roomIds = rooms.map(r => r._id.toString());

        if (roomIds.length === 0) {
            return res.status(200).json({ total: 0, perRoom: {} });
        }

        // প্রতিটা রুমের unread count — যে মেসেজে ইউজারের নাম readBy তে নেই
        const unreadCounts = await Message.aggregate([
            {
                $match: {
                    room: { $in: roomIds },
                    sender: { $ne: username },
                    readBy: { $nin: [username] }
                }
            },
            {
                $group: {
                    _id: '$room',
                    count: { $sum: 1 }
                }
            }
        ]);

        const perRoom = {};
        let total = 0;
        unreadCounts.forEach(item => {
            perRoom[item._id] = item.count;
            total += item.count;
        });

        res.status(200).json({ total, perRoom });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ================== ✅ MARK AS READ API ==================
// কোনো রুমের সব মেসেজ "read" মার্ক করার API
router.post('/read/:room/:username', async (req, res) => {
    try {
        const { room, username } = req.params;

        // এই রুমে username readBy তে নেই এমন সব মেসেজ আপডেট
        const result = await Message.updateMany(
            {
                room: room,
                sender: { $ne: username },
                readBy: { $nin: [username] }
            },
            {
                $addToSet: { readBy: username },
                $set: { status: 'read', readAt: new Date() }
            }
        );

        // ✅ Socket দিয়ে sender দের জানানো — তাদের মেসেজ read হয়ে গেছে
        if (global.io && result.modifiedCount > 0) {
            global.io.to(room).emit('messages_read', {
                room,
                readBy: username,
                readAt: new Date().toISOString()
            });
        }

        res.status(200).json({ marked: result.modifiedCount });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ================== ✅ MARK AS DELIVERED API ==================
router.post('/delivered/:room/:username', async (req, res) => {
    try {
        const { room, username } = req.params;

        const result = await Message.updateMany(
            {
                room: room,
                sender: { $ne: username },
                deliveredTo: { $nin: [username] }
            },
            {
                $addToSet: { deliveredTo: username },
                $set: { deliveredAt: new Date() }
            }
        );

        // status আপডেট — যদি এখনো 'sent' থাকে তাহলে 'delivered' করা
        await Message.updateMany(
            {
                room: room,
                sender: { $ne: username },
                status: 'sent'
            },
            { $set: { status: 'delivered' } }
        );

        if (global.io && result.modifiedCount > 0) {
            global.io.to(room).emit('messages_delivered', {
                room,
                deliveredTo: username,
                deliveredAt: new Date().toISOString()
            });
        }

        res.status(200).json({ marked: result.modifiedCount });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ================== ✅ LAST MESSAGE PER ROOM API ==================
// চ্যাট লিস্টে শেষ মেসেজ দেখানোর জন্য
router.post('/last-messages', async (req, res) => {
    try {
        const { roomIds } = req.body;
        if (!Array.isArray(roomIds) || roomIds.length === 0) {
            return res.status(200).json({});
        }

        const lastMessages = await Message.aggregate([
            { $match: { room: { $in: roomIds } } },
            { $sort: { createdAt: -1 } },
            {
                $group: {
                    _id: '$room',
                    lastText: { $first: '$text' },
                    lastSender: { $first: '$sender' },
                    lastFileUrl: { $first: '$fileUrl' },
                    lastTime: { $first: '$createdAt' }
                }
            }
        ]);

        const result = {};
        lastMessages.forEach(m => {
            result[m._id] = {
                text: m.lastText || (m.lastFileUrl ? '📎 Attachment' : ''),
                sender: m.lastSender,
                time: m.lastTime
            };
        });

        res.status(200).json(result);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

module.exports = router;