require('dotenv').config(); // এটি সবার উপরে থাকবে
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const http = require('http'); 
const { Server } = require('socket.io'); 
const webpush = require('web-push'); // নতুন পুশ নোটিফিকেশন প্যাকেজ

const app = express();
const server = http.createServer(app); 

// ================= Web Push (VAPID) Setup =================
// এই চাবিগুলো দিয়ে ব্রাউজার চিনতে পারবে নোটিফিকেশন কোথা থেকে আসছে
const publicVapidKey = process.env.VAPID_PUBLIC_KEY || 'BEl62iUYgUivxIkv69yViEuiBIa-Ib9-SkvMeAtA3LFgDzkrxZJjSgSnfckjBJuBkr3qBUYIHBQFLXYp5Nksh8U';
const privateVapidKey = process.env.VAPID_PRIVATE_KEY || '178fJbYV518x3fHmsG1yC_kQ1J6U2Y324Q_K-R8BfI0';
webpush.setVapidDetails('mailto:secure.nasim@gmail.com', publicVapidKey, privateVapidKey);

// MongoDB তে নোটিফিকেশন সাবস্ক্রিপশন সেভ করার স্কিমা
const subscriptionSchema = new mongoose.Schema({
    userName: String,
    subscription: Object
});
const PushSubscription = mongoose.model('PushSubscription', subscriptionSchema);

// গ্লোবাল ফাংশন: যাতে অন্যান্য রাউট (যেমন chat.js বা projects.js) থেকেও নোটিফিকেশন পাঠানো যায়
global.sendPushNotification = async (userName, payload) => {
    try {
        const subs = await PushSubscription.find({ userName });
        subs.forEach(sub => {
            webpush.sendNotification(sub.subscription, JSON.stringify(payload)).catch(err => {
                console.error('Push error:', err);
                // যদি ইউজার নোটিফিকেশন ব্লক করে দেয় বা টোকেন এক্সপায়ার হয়, তবে ডাটাবেস থেকে মুছে ফেলব
                if (err.statusCode === 410 || err.statusCode === 404) {
                    PushSubscription.deleteOne({ _id: sub._id }).exec();
                }
            });
        });
    } catch (err) {
        console.log("Error sending push notification:", err);
    }
};

// Socket.io সেটআপ
const io = new Server(server, {
    cors: {
        origin: "*", 
        methods: ["GET", "POST"]
    }
});

// Middleware
app.use(cors());
app.use(express.json());

// হোম রুট (যাতে ব্রাউজারে Cannot GET / না দেখায়)
app.get('/', (req, res) => {
    res.send('🚀 Fortivus Group Agency Server is running and healthy!');
});

// ================= Push Notification Routes =================
// ইউজার লগইন করলে বা পারমিশন দিলে তার ডিভাইস ডাটাবেসে সেভ হবে
app.post('/api/subscribe', async (req, res) => {
    try {
        const { userName, subscription } = req.body;
        // একই ডিভাইসের ডুপ্লিকেট এড়াতে চেক করা
        const exists = await PushSubscription.findOne({ 'subscription.endpoint': subscription.endpoint });
        if (!exists) {
            await new PushSubscription({ userName, subscription }).save();
        }
        res.status(201).json({ message: 'Subscribed to push notifications successfully' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ইউজার লগআউট করলে তার ডিভাইস ডাটাবেস থেকে ডিলিট করে দেব (যাতে অন্য কেউ নোটিফিকেশন না পায়)
app.post('/api/unsubscribe', async (req, res) => {
    try {
        const { endpoint } = req.body;
        await PushSubscription.deleteOne({ 'subscription.endpoint': endpoint });
        res.status(200).json({ message: 'Unsubscribed successfully' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});
// ============================================================

// Routes কানেক্ট করা
const projectRoutes = require('./routes/projects');
const clientRoutes = require('./routes/clients');
const employeeRoutes = require('./routes/employees');
const authRoutes = require('./routes/auth');
const settingsRoutes = require('./routes/settings');
const driveRoutes = require('./routes/drive');
const chatRoutes = require('./routes/chat');

app.use('/api/projects', projectRoutes);
app.use('/api/clients', clientRoutes);
app.use('/api/employees', employeeRoutes);
app.use('/api/auth', authRoutes);
app.use('/api/settings', settingsRoutes);
app.use('/api/drive', driveRoutes);
app.use('/api/chat', chatRoutes);

// অনলাইন ইউজারদের ট্র্যাক করার জন্য Map
const onlineUsers = new Map();

// ================= Socket.io রিয়েল-টাইম ইভেন্ট =================
io.on('connection', (socket) => {
    console.log(`🔌 User connected: ${socket.id}`);

    // ইউজার কানেক্ট হলে তাকে অনলাইন লিস্টে অ্যাড করা এবং সবাইকে জানানো
    socket.on('user_connected', (userName) => {
        onlineUsers.set(socket.id, userName);
        io.emit('online_users', Array.from(onlineUsers.values()));
        console.log(`✅ User ${userName} is now online`);
    });

    // রুমে জয়েন করা
    socket.on('join_room', (data) => {
        socket.join(data);
        console.log(`User ${socket.id} joined room: ${data}`);
    });

    // সাধারণ মেসেজ বা ফাইল/ছবি পাঠানো
    socket.on('send_message', (data) => {
        socket.to(data.room).emit('receive_message', data);
    });

    // ================= WebRTC Call Signaling =================
    
    // ১. কেউ কল দিলে সেটা রিসিভারের কাছে পাঠানো
    socket.on('call_user', (data) => {
        socket.to(data.room).emit('incoming_call', {
            signal: data.signal,
            callerName: data.callerName,
            callerSocket: socket.id,
            isVideo: data.isVideo,
            isGroup: data.isGroup // গ্রুপ কলের জন্য
        });
    });

    // ২. রিসিভার কল রিসিভ করলে কলারকে জানানো
    socket.on('answer_call', (data) => {
        socket.to(data.room).emit('call_accepted', data.signal);
    });

    // ৩. পিয়ার টু পিয়ার কানেকশনের জন্য ICE Candidate পাঠানো
    socket.on('ice_candidate', (data) => {
        socket.to(data.room).emit('ice_candidate', data.candidate);
    });

    // ৪. কল কেটে দিলে সবাইকে জানানো
    socket.on('end_call', (data) => {
        socket.to(data.room).emit('call_ended');
    });

    // ==============================================================================

    socket.on('disconnect', () => {
        console.log(`🚫 User disconnected: ${socket.id}`);
        // ইউজার বের হয়ে গেলে অনলাইন লিস্ট থেকে রিমুভ করা এবং সবাইকে জানানো
        onlineUsers.delete(socket.id);
        io.emit('online_users', Array.from(onlineUsers.values()));
    });
});

// MongoDB কানেকশন
const MONGO_URI = process.env.MONGO_URI || "mongodb+srv://nasimsharkarofficial_db_user:AgencyNasim2026@fortivus-group-llc.3iqgbfe.mongodb.net/?retryWrites=true&w=majority";

mongoose.connect(MONGO_URI)
    .then(() => console.log('✅ MongoDB is Connected Successfully!'))
    .catch((err) => {
        console.log('❌ DB Connection Error:', err.message);
    });

// পোর্ট সেটআপ
const PORT = process.env.PORT || 8080;

server.listen(PORT, () => {
    console.log(`🚀 Server is running on port ${PORT}`);
});