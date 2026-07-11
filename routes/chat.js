const express = require('express');
const router = express.Router();
const Message = require('../models/Message');
const Room = require('../models/Room');
const { authenticate } = require('../middleware/authenticate');
const { deliverNotificationToReferences } = require('../services/notificationDelivery');
const { resolveUsersForReferences } = require('../services/pushRecipients');

const getSafeMessagePreview = (text, hasAttachment) => {
    const normalized = String(text || '').replace(/\s+/g, ' ').trim();
    if (!normalized) return hasAttachment ? 'Sent an attachment' : 'Sent a message';
    const characters = Array.from(normalized);
    return characters.slice(0, 80).join('') + (characters.length > 80 ? '…' : '');
};

const getRoomMemberReferences = (room) => {
    const immutableIds = Array.from(room?.memberUserIds || []);
    const legacyReferences = Array.from(room?.members || []);
    if (immutableIds.length && immutableIds.length >= legacyReferences.length) return immutableIds;
    return [...immutableIds, ...legacyReferences];
};

const roomContainsUser = async (room, user) => {
    if (!room || !user?._id) return false;
    const members = await resolveUsersForReferences(getRoomMemberReferences(room));
    const legacyMemberCount = new Set((room.members || []).map(String).filter(Boolean)).size;
    if (!room.memberUserIds?.length && members.length && members.length === legacyMemberCount) {
        const memberUserIds = members.map(member => member._id);
        room.memberUserIds = memberUserIds;
        void Room.updateOne(
            { _id: room._id, $or: [{ memberUserIds: { $exists: false } }, { memberUserIds: { $size: 0 } }] },
            { $set: { memberUserIds } }
        ).catch(() => {});
    }
    return members.some(member => member._id.toString() === user._id.toString());
};

const findRoomsForUser = async (user) => {
    const rooms = await Room.find({
        $or: [
            { memberUserIds: user._id },
            { members: user.name },
            { members: user.email }
        ]
    });
    const checkedRooms = await Promise.all(rooms.map(async room => (
        await roomContainsUser(room, user) ? room : null
    )));
    return checkedRooms.filter(Boolean);
};

const buildMessagePush = ({ savedMessage, room, sender }) => {
    const eventId = `message:${savedMessage._id}`;
    const previewText = getSafeMessagePreview(savedMessage.text, Boolean(savedMessage.fileUrl));
    return {
        references: getRoomMemberReferences(room),
        eventId,
        payload: {
            type: 'message',
            title: room.isGroup ? `New message in ${room.name}` : `New message from ${sender.name}`,
            body: room.isGroup ? `${sender.name}: ${previewText}` : previewText,
            url: `/dashboard?chat=${encodeURIComponent(room._id.toString())}`,
            entityId: room._id.toString(),
            eventId,
            tag: eventId,
            senderUserId: sender._id.toString()
        },
        excludeReferences: [sender._id, sender.name, sender.email]
    };
};

// ================== ROOM (Group/Private Chat) API ==================

// ইউজারের চ্যাট লিস্ট (রুম/গ্রুপ) তুলে আনার API
router.get('/rooms/:username', authenticate, async (req, res) => {
    try {
        const rooms = await findRoomsForUser(req.user);
        res.status(200).json(rooms);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// নতুন গ্রুপ বা প্রাইভেট চ্যাট (রুম) ক্রিয়েট করার API
router.post('/rooms', authenticate, async (req, res) => {
    try {
        const { name, isGroup, members } = req.body;
        const resolvedMembers = await resolveUsersForReferences([
            ...(Array.isArray(members) ? members : []),
            req.user._id
        ]);
        const uniqueMembers = new Map(resolvedMembers.map(user => [user._id.toString(), user]));
        if (!uniqueMembers.has(req.user._id.toString())) {
            return res.status(403).json({ error: 'The authenticated user must belong to the conversation' });
        }
        if ((!isGroup && uniqueMembers.size !== 2) || (isGroup && uniqueMembers.size < 3)) {
            return res.status(400).json({
                error: isGroup
                    ? 'A group conversation requires at least three valid members'
                    : 'A private conversation requires exactly two valid members'
            });
        }
        const memberUsers = [...uniqueMembers.values()];
        const memberUserIds = memberUsers.map(user => user._id);
        const memberLabels = memberUsers.map(user => user.name || user.email);

        // প্রাইভেট চ্যাট হলে আগে চেক করবো এই দুইজনের মাঝে কোনো রুম আছে কি না
        if (!isGroup) {
            const existingRoom = await Room.findOne({
                isGroup: false,
                $or: [
                    { memberUserIds: { $all: memberUserIds, $size: memberUserIds.length } },
                    { members: { $all: memberLabels, $size: memberLabels.length } }
                ]
            });
            if (existingRoom) {
                return res.status(200).json(existingRoom);
            }
        }

        const newRoom = new Room({
            name,
            isGroup,
            members: memberLabels,
            memberUserIds,
            createdBy: req.user.name
        });
        const savedRoom = await newRoom.save();
        res.status(201).json(savedRoom);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ================== MESSAGE API ==================

// নির্দিষ্ট কোনো রুম বা গ্রুপের আগের সব মেসেজ তুলে আনার API
router.get('/:room', authenticate, async (req, res) => {
    try {
        if (req.params.room === 'rooms') return res.status(400).send('Invalid room id');

        const room = await Room.findById(req.params.room);
        if (!room) return res.status(404).json({ error: 'Conversation not found' });
        if (!await roomContainsUser(room, req.user)) {
            return res.status(403).json({ error: 'You are not a member of this conversation' });
        }
        const messages = await Message.find({ room: req.params.room }).sort({ createdAt: 1 });
        res.status(200).json(messages);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ডাটাবেসে নতুন মেসেজ সেভ করার API — ✅ status tracking সহ
router.post('/', authenticate, async (req, res) => {
    try {
        const roomData = await Room.findById(req.body.room);
        if (!roomData) return res.status(404).json({ error: 'Conversation not found' });

        if (!await roomContainsUser(roomData, req.user)) {
            return res.status(403).json({ error: 'You are not a member of this conversation' });
        }

        const sender = req.user.name;
        const newMessage = new Message({
            room: req.body.room,
            sender,
            text: req.body.text,
            fileUrl: req.body.fileUrl || '',
            time: req.body.time,
            status: 'sent',
            deliveredTo: [],
            readBy: [sender] // নিজে তো নিজের মেসেজ দেখেছে
        });

        const savedMessage = await newMessage.save();

        // The server emits only the persisted record. Realtime display no longer
        // depends on a sender-controlled follow-up relay after the REST response.
        if (global.io) {
            const realtimeMessage = typeof savedMessage.toObject === 'function'
                ? savedMessage.toObject()
                : savedMessage;
            global.io.to(roomData._id.toString()).emit('receive_message', {
                ...realtimeMessage,
                id: savedMessage._id.toString()
            });
        }

        // Notification delivery is intentionally non-blocking: channel failures must
        // never roll back or delay an already persisted message.
        const notification = buildMessagePush({ savedMessage, room: roomData, sender: req.user });
        void deliverNotificationToReferences(notification.references, notification.payload, {
            eventId: notification.eventId,
            excludeReferences: notification.excludeReferences
        }).catch(error => console.error('Message notification delivery failed:', error.message));

        res.status(201).json(savedMessage);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ================== ✅ UNREAD COUNT API ==================
// একটি ইউজারের সব রুমের unread message count বের করার API
router.get('/unread/:username', authenticate, async (req, res) => {
    try {
        const username = req.user.name;

        // ইউজার যে রুমগুলোতে আছে সেগুলো বের করা
        const rooms = await findRoomsForUser(req.user);
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
router.post('/read/:room/:username', authenticate, async (req, res) => {
    try {
        const { room } = req.params;
        const username = req.user.name;
        const roomData = await Room.findById(room);
        if (!roomData) return res.status(404).json({ error: 'Conversation not found' });
        if (!await roomContainsUser(roomData, req.user)) {
            return res.status(403).json({ error: 'You are not a member of this conversation' });
        }

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
router.post('/delivered/:room/:username', authenticate, async (req, res) => {
    try {
        const { room } = req.params;
        const username = req.user.name;
        const roomData = await Room.findById(room);
        if (!roomData) return res.status(404).json({ error: 'Conversation not found' });
        if (!await roomContainsUser(roomData, req.user)) {
            return res.status(403).json({ error: 'You are not a member of this conversation' });
        }

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
router.post('/last-messages', authenticate, async (req, res) => {
    try {
        const { roomIds } = req.body;
        if (!Array.isArray(roomIds) || roomIds.length === 0) {
            return res.status(200).json({});
        }

        const rooms = await findRoomsForUser(req.user);
        const allowedRoomIds = new Set(rooms.map(room => room._id.toString()));
        const safeRoomIds = roomIds.filter(roomId => allowedRoomIds.has(String(roomId)));

        const lastMessages = await Message.aggregate([
            { $match: { room: { $in: safeRoomIds } } },
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
module.exports.getSafeMessagePreview = getSafeMessagePreview;
module.exports.getRoomMemberReferences = getRoomMemberReferences;
module.exports.buildMessagePush = buildMessagePush;
