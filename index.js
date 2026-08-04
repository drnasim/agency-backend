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
const Room = require('./models/Room');
const { initializeWebPush } = require('./config/push');
const { attachAuthenticatedSocketUser, getJwtSecret } = require('./middleware/authenticate');
const { getNotificationSocketRoom, isPublicChatSocketRoom } = require('./services/socketNotifications');
const { resolveUsersForReferences } = require('./services/pushRecipients');

const app = express();
const server = http.createServer(app); 
let isShuttingDown = false;

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

// Browser Web Push is optional. Invalid or absent VAPID configuration disables only
// that delivery channel; authenticated HTTP and Socket.IO realtime must still start.
const webPushInitialization = initializeWebPush();
if (!webPushInitialization.available) {
    console.warn(`Browser Web Push is unavailable; realtime notifications remain enabled. ${webPushInitialization.error.message}`);
}
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

app.get('/health/live', (req, res) => {
    res.status(200).json({ status: 'ok' });
});

app.get('/health/ready', (req, res) => {
    const databaseConnected = mongoose.connection.readyState === 1;
    const ready = server.listening && databaseConnected && !isShuttingDown;

    res.status(ready ? 200 : 503).json({
        status: ready ? 'ready' : 'not_ready',
        database: databaseConnected ? 'connected' : 'disconnected'
    });
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
io.use(attachAuthenticatedSocketUser);

io.on('connection', (socket) => {
    console.log(`🔌 User connected: ${socket.id}`);

    let currentUserName = '';
    const authorizedChatRooms = new Set();

    const authorizeChatRoom = async (roomValue) => {
        if (!socket.authenticatedUser?._id || !isPublicChatSocketRoom(roomValue)) return '';
        const roomId = roomValue.trim();
        if (authorizedChatRooms.has(roomId)) return roomId;

        try {
            const room = await Room.findById(roomId).select('members memberUserIds').lean();
            if (!room) return '';
            const immutableIds = Array.from(room.memberUserIds || []);
            const legacyReferences = Array.from(room.members || []);
            const references = immutableIds.length && immutableIds.length >= legacyReferences.length
                ? immutableIds
                : [...immutableIds, ...legacyReferences];
            const members = await resolveUsersForReferences(references);
            const authenticatedUserId = socket.authenticatedUser._id.toString();
            if (!members.some(user => user._id.toString() === authenticatedUserId)) return '';
            socket.join(roomId);
            authorizedChatRooms.add(roomId);
            return roomId;
        } catch {
            return '';
        }
    };

    if (socket.authenticatedUser?._id) {
        socket.join(getNotificationSocketRoom(socket.authenticatedUser._id));
    }

    socket.on('user_connected', (userName) => {
        currentUserName = userName;
        onlineUsers.set(socket.id, userName);
        io.emit('online_users', Array.from(onlineUsers.values()));
        console.log(`✅ User ${userName} is now online`);
    });

    socket.on('join_room', async (data, acknowledge) => {
        const room = await authorizeChatRoom(data);
        if (room) console.log(`User ${currentUserName || socket.id} joined room: ${room}`);
        if (typeof acknowledge === 'function') acknowledge({ joined: Boolean(room) });
    });

    socket.on('send_message', () => {
        // Saved messages are emitted by the authenticated REST path. Retaining this
        // no-op event keeps older clients connected without trusting relay payloads.
    });

    // ✅ মেসেজ ডেলিভার হওয়ার ইভেন্ট — ইউজার কানেক্ট হলে তার রুমের মেসেজ delivered মার্ক হবে
    socket.on('mark_delivered', async ({ room } = {}) => {
        const authorizedRoom = await authorizeChatRoom(room);
        if (!authorizedRoom) return;
        const username = socket.authenticatedUser.name;
        try {
            const Message = require('./models/Message');
            await Message.updateMany(
                { room: authorizedRoom, sender: { $ne: username }, deliveredTo: { $nin: [username] } },
                { $addToSet: { deliveredTo: username }, $set: { deliveredAt: new Date() } }
            );
            // status 'sent' → 'delivered' আপডেট
            await Message.updateMany(
                { room: authorizedRoom, sender: { $ne: username }, status: 'sent' },
                { $set: { status: 'delivered' } }
            );
            socket.to(authorizedRoom).emit('messages_delivered', { room: authorizedRoom, deliveredTo: username, deliveredAt: new Date().toISOString() });
        } catch (e) { /* silent */ }
    });

    // ✅ মেসেজ read হওয়ার ইভেন্ট — ইউজার চ্যাট ওপেন করলে read মার্ক হবে
    socket.on('mark_read', async ({ room } = {}) => {
        const authorizedRoom = await authorizeChatRoom(room);
        if (!authorizedRoom) return;
        const username = socket.authenticatedUser.name;
        try {
            const Message = require('./models/Message');
            await Message.updateMany(
                { room: authorizedRoom, sender: { $ne: username }, readBy: { $nin: [username] } },
                { $addToSet: { readBy: username }, $set: { status: 'read', readAt: new Date() } }
            );
            socket.to(authorizedRoom).emit('messages_read', { room: authorizedRoom, readBy: username, readAt: new Date().toISOString() });
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

const runStartupMaintenance = async () => {
    try {
        // Legacy records used a nested, unauthenticated subscription object and cannot
        // be delivered after the mandatory VAPID rotation. Remove them without logging keys.
        const PushSubscription = require('./models/PushSubscription');
        const legacyCleanup = await PushSubscription.deleteMany({
            $or: [{ endpoint: { $exists: false } }, { userId: { $exists: false } }]
        });
        await PushSubscription.syncIndexes();
        if (legacyCleanup.deletedCount) {
            console.log(`Removed ${legacyCleanup.deletedCount} legacy browser push subscription(s)`);
        }
    } catch (err) {
        // Maintenance should be observable, but it must not make an otherwise healthy
        // database connection unavailable to the application.
        console.error('❌ Startup maintenance failed:', err.message);
    }
};

// ====================== CRON: sentToday রিসেট প্রতিদিন মধ্যরাতে ======================
const getWarmupLimit = (day) => {
    if (day <= 7)  return 10;
    if (day <= 14) return 20;
    if (day <= 21) return 30;
    return 50;
};

const runDailyEmailMaintenance = async () => {
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
};

const PORT = process.env.PORT || 8080;
const MONGO_CONNECT_OPTIONS = {
    serverSelectionTimeoutMS: 15000,
    connectTimeoutMS: 15000
};

let dailyResetTask = null;
let startPromise = null;
let stopPromise = null;

const listen = () => new Promise((resolve, reject) => {
    const handleListenError = (error) => {
        server.off('listening', handleListening);
        reject(error);
    };
    const handleListening = () => {
        server.off('error', handleListenError);
        resolve();
    };

    server.once('error', handleListenError);
    server.once('listening', handleListening);
    server.listen(PORT);
});

const startServer = () => {
    if (startPromise) return startPromise;

    startPromise = (async () => {
        if (!MONGO_URI) throw new Error('MONGO_URI is required');

        await mongoose.connect(MONGO_URI, MONGO_CONNECT_OPTIONS);
        console.log('✅ MongoDB is Connected Successfully!');

        await runStartupMaintenance();
        await listen();

        dailyResetTask = cron.schedule('0 0 * * *', runDailyEmailMaintenance);
        console.log(`🚀 Server is running on port ${PORT}`);
        return server;
    })();

    return startPromise;
};

const closeHttpServer = () => new Promise((resolve, reject) => {
    if (!server.listening) {
        server.closeAllConnections?.();
        resolve();
        return;
    }

    server.close((error) => {
        if (error) reject(error);
        else {
            server.closeAllConnections?.();
            resolve();
        }
    });
    server.closeIdleConnections?.();
});

const stopServer = () => {
    if (stopPromise) return stopPromise;

    isShuttingDown = true;
    stopPromise = (async () => {
        dailyResetTask?.stop();
        dailyResetTask = null;

        io.disconnectSockets(true);
        await closeHttpServer();

        if (mongoose.connection.readyState !== 0) {
            await mongoose.disconnect();
        }
    })();

    return stopPromise;
};

const shutdownFromSignal = async (signal) => {
    console.log(`${signal} received; shutting down gracefully.`);
    try {
        await stopServer();
        process.exit(0);
    } catch (error) {
        console.error('❌ Graceful shutdown failed:', error.message);
        process.exit(1);
    }
};

if (require.main === module) {
    process.once('SIGTERM', () => shutdownFromSignal('SIGTERM'));
    process.once('SIGINT', () => shutdownFromSignal('SIGINT'));

    startServer().catch(async (error) => {
        console.error('❌ Server startup failed:', error.message);
        try {
            await stopServer();
        } catch (shutdownError) {
            console.error('❌ Startup cleanup failed:', shutdownError.message);
        }
        process.exit(1);
    });
}

module.exports = {
    app,
    runDailyEmailMaintenance,
    runStartupMaintenance,
    server,
    startServer,
    stopServer
};
