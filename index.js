require('dotenv').config();
// Force IPv4 DNS resolution — some hosted containers fail on IPv6 outbound (ENETUNREACH)
const dns = require('dns');
dns.setDefaultResultOrder('ipv4first');

const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const http = require('http');
const { Server } = require('socket.io');
const cron = require('node-cron');
const EmailAccount = require('./models/EmailAccount');
const { configureWebPush } = require('./config/push');
const { getJwtSecret } = require('./middleware/authenticate');

const app = express();
const server = http.createServer(app); 

const DAILY_LIMIT_TIMEZONE = process.env.DAILY_LIMIT_TIMEZONE || process.env.TZ || 'UTC';

const getDailyLimitDateKey = (date = new Date(), timeZone = DAILY_LIMIT_TIMEZONE) => {
    const buildKey = (selectedTimeZone) => {
        const parts = new Intl.DateTimeFormat('en-US', {
            timeZone: selectedTimeZone,
            year: 'numeric',
            month: '2-digit',
            day: '2-digit'
        }).formatToParts(date).reduce((acc, part) => {
            acc[part.type] = part.value;
            return acc;
        }, {});
        return `${parts.year}-${parts.month}-${parts.day}`;
    };

    try {
        return buildKey(timeZone);
    } catch {
        return buildKey('UTC');
    }
};

// Fail fast with actionable errors instead of accepting unusable browser subscriptions.
configureWebPush();
getJwtSecret();

const allowedOrigins = [
  'https://login.fortivusgroupllc.com',
  'https://fortivusgroupllc.com',
  'https://www.fortivusgroupllc.com',
  'http://localhost:5173',
  'http://127.0.0.1:5173',
  'http://127.0.0.1:5174',
  'http://localhost:5174',
  'http://localhost:3000'
].concat(String(process.env.FRONTEND_URL || '')
  .split(',')
  .map(origin => origin.trim().replace(/\/$/, ''))
  .filter(Boolean));

const io = new Server(server, {
    cors: {
        origin: allowedOrigins,
        methods: ["GET", "POST"],
        credentials: true
    }
});

// ✅ routes থেকে io access করার জন্য global এ expose করা
global.io = io;

app.use(cors({
  origin: function(origin, callback) {
    if (!origin || allowedOrigins.includes(origin)) {
      callback(null, true);
    } else {
      callback(new Error('Not allowed by CORS'));
    }
  },
  credentials: true
}));
app.use(express.json());

app.get('/', (req, res) => {
    res.send('🚀 Fortivus Group Agency Server is running and healthy!');
});

const projectRoutes = require('./routes/projects');
const clientRoutes = require('./routes/clients');
const employeeRoutes = require('./routes/employees');
const authRoutes = require('./routes/auth');
const settingsRoutes = require('./routes/settings');
const driveRoutes = require('./routes/drive');
const chatRoutes = require('./routes/chat');
const financeRoutes = require('./routes/finance');
const cryptoRoutes = require('./routes/crypto');
const uploadRoutes = require('./routes/upload'); // <--- Cloudflare R2 Upload Route
const mailRoutes = require('./routes/mail');
const liveTvRoutes = require('./routes/liveTv');
const pushRoutes = require('./routes/push');

app.use('/api/projects', projectRoutes);
app.use('/api/clients', clientRoutes);
app.use('/api/employees', employeeRoutes);
app.use('/api/auth', authRoutes);
app.use('/api/settings', settingsRoutes);
app.use('/api/drive', driveRoutes);
app.use('/api/chat', chatRoutes);
app.use('/api/finance', financeRoutes);
app.use('/api/crypto', cryptoRoutes);
app.use('/api/upload', uploadRoutes); // <--- Cloudflare R2 Upload Route connected
app.use('/api/mail', mailRoutes);
app.use('/api/live-tv', liveTvRoutes);
app.use('/api/push', pushRoutes);

const onlineUsers = new Map();

// ================= Socket.io রিয়েল-টাইম ইভেন্ট =================
io.on('connection', (socket) => {
    console.log(`🔌 User connected: ${socket.id}`);

    let currentUserName = '';

    socket.on('user_connected', (userName) => {
        currentUserName = userName;
        onlineUsers.set(socket.id, userName);
        io.emit('online_users', Array.from(onlineUsers.values()));
        console.log(`✅ User ${userName} is now online`);
    });

    socket.on('join_room', (data) => {
        if (data) {
            socket.join(data);
            console.log(`User ${currentUserName || socket.id} joined room: ${data}`);
        }
    });

    socket.on('send_message', async (data) => {
        if (data && data.room) {
            socket.to(data.room).emit('receive_message', data);
        }

        // Browser push is emitted only by the authoritative REST save path.
        // Keeping it out of this relay prevents one saved message producing two pushes.
    });

    // ✅ মেসেজ ডেলিভার হওয়ার ইভেন্ট — ইউজার কানেক্ট হলে তার রুমের মেসেজ delivered মার্ক হবে
    socket.on('mark_delivered', async ({ room, username }) => {
        try {
            const Message = require('./models/Message');
            await Message.updateMany(
                { room, sender: { $ne: username }, deliveredTo: { $nin: [username] } },
                { $addToSet: { deliveredTo: username }, $set: { deliveredAt: new Date() } }
            );
            // status 'sent' → 'delivered' আপডেট
            await Message.updateMany(
                { room, sender: { $ne: username }, status: 'sent' },
                { $set: { status: 'delivered' } }
            );
            socket.to(room).emit('messages_delivered', { room, deliveredTo: username, deliveredAt: new Date().toISOString() });
        } catch (e) { /* silent */ }
    });

    // ✅ মেসেজ read হওয়ার ইভেন্ট — ইউজার চ্যাট ওপেন করলে read মার্ক হবে
    socket.on('mark_read', async ({ room, username }) => {
        try {
            const Message = require('./models/Message');
            await Message.updateMany(
                { room, sender: { $ne: username }, readBy: { $nin: [username] } },
                { $addToSet: { readBy: username }, $set: { status: 'read', readAt: new Date() } }
            );
            socket.to(room).emit('messages_read', { room, readBy: username, readAt: new Date().toISOString() });
        } catch (e) { /* silent */ }
    });

    socket.on('disconnect', () => {
        console.log(`🚫 User disconnected: ${socket.id}`);
        if (currentUserName) {
            onlineUsers.delete(socket.id);
            io.emit('online_users', Array.from(onlineUsers.values()));
        }
    });
});

const MONGO_URI = String(process.env.MONGO_URI || '').trim();
if (!MONGO_URI) throw new Error('MONGO_URI is required');

mongoose.connect(MONGO_URI)
    .then(async () => {
        // Legacy records used a nested, unauthenticated subscription object and cannot
        // be delivered after the mandatory VAPID rotation. Remove them without logging keys.
        const PushSubscription = require('./models/PushSubscription');
        const legacyCleanup = await PushSubscription.deleteMany({
            $or: [{ endpoint: { $exists: false } }, { userId: { $exists: false } }]
        });
        await PushSubscription.syncIndexes();
        console.log('✅ MongoDB is Connected Successfully!');
        if (legacyCleanup.deletedCount) {
            console.log(`Removed ${legacyCleanup.deletedCount} legacy browser push subscription(s)`);
        }
    })
    .catch((err) => {
        console.log('❌ DB Connection Error:', err.message);
    });

// ====================== CRON: sentToday রিসেট প্রতিদিন মধ্যরাতে ======================
const getWarmupLimit = (day) => {
    if (day <= 7)  return 10;
    if (day <= 14) return 20;
    if (day <= 21) return 30;
    return 50;
};

cron.schedule('0 0 * * *', async () => {
    try {
        const todayKey = getDailyLimitDateKey();
        await EmailAccount.updateMany({}, { sentToday: 0, sentTodayDate: todayKey });

        // warmupEnabled accounts: warmupDay++ এবং dailyLimit auto-update
        const warmupAccounts = await EmailAccount.find({ warmupEnabled: true });
        for (const acc of warmupAccounts) {
            const newDay = acc.warmupDay + 1;
            const newLimit = getWarmupLimit(newDay);
            await EmailAccount.findByIdAndUpdate(acc._id, {
                warmupDay: newDay,
                dailyLimit: newLimit
            });
        }
        console.log(`✅ sentToday reset + warmupDay incremented for ${warmupAccounts.length} accounts`);
    } catch (err) {
        console.error('❌ Cron job failed:', err.message);
    }
});

const PORT = process.env.PORT || 8080;

server.listen(PORT, () => {
    console.log(`🚀 Server is running on port ${PORT}`);
});
