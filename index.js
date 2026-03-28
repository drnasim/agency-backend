require('dotenv').config(); 
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const http = require('http'); 
const { Server } = require('socket.io'); 
const webpush = require('web-push'); 

const app = express();
const server = http.createServer(app); 

// ================= Web Push (VAPID) Setup =================
const publicVapidKey = process.env.VAPID_PUBLIC_KEY || 'BEl62iUYgUivxIkv69yViEuiBIa-Ib9-SkvMeAtA3LFgDzkrxZJjSgSnfckjBJuBkr3qBUYIHBQFLXYp5Nksh8U';
const privateVapidKey = process.env.VAPID_PRIVATE_KEY || '178fJbYV518x3fHmsG1yC_kQ1J6U2Y324Q_K-R8BfI0';
webpush.setVapidDetails('mailto:secure.nasim@gmail.com', publicVapidKey, privateVapidKey);

const subscriptionSchema = new mongoose.Schema({
    userName: String,
    subscription: Object
});
const PushSubscription = mongoose.model('PushSubscription', subscriptionSchema);

global.sendPushNotification = async (userName, payload) => {
    try {
        const subs = await PushSubscription.find({ userName });
        if (subs.length === 0) return; 

        const promises = subs.map(sub => {
            return webpush.sendNotification(sub.subscription, JSON.stringify(payload)).catch(err => {
                console.error('Push error:', err);
                if (err.statusCode === 410 || err.statusCode === 404) {
                    PushSubscription.deleteOne({ _id: sub._id }).exec();
                }
            });
        });
        await Promise.all(promises);
    } catch (err) {
        console.log("Error sending push notification:", err);
    }
};

const io = new Server(server, {
    cors: {
        origin: "*", 
        methods: ["GET", "POST"]
    }
});

app.use(cors());
app.use(express.json());

app.get('/', (req, res) => {
    res.send('🚀 Fortivus Group Agency Server is running and healthy!');
});

// ================= Push Notification Routes =================
app.post('/api/subscribe', async (req, res) => {
    try {
        const { userName, subscription } = req.body;
        const exists = await PushSubscription.findOne({ 'subscription.endpoint': subscription.endpoint });
        if (!exists) {
            await new PushSubscription({ userName, subscription }).save();
        }
        res.status(201).json({ message: 'Subscribed to push notifications successfully' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/unsubscribe', async (req, res) => {
    try {
        const { endpoint } = req.body;
        await PushSubscription.deleteOne({ 'subscription.endpoint': endpoint });
        res.status(200).json({ message: 'Unsubscribed successfully' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

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
        
        try {
            const ChatRoom = mongoose.model('ChatRoom'); 
            const room = await ChatRoom.findById(data.room);
            if (room) {
                const receivers = room.members.filter(m => m !== data.sender);
                receivers.forEach(receiverName => {
                    const payload = {
                        title: `New Message from ${data.sender}`,
                        body: data.text || "Sent an attachment 📎",
                        url: "/dashboard" 
                    };
                    global.sendPushNotification(receiverName, payload);
                });
            }
        } catch (error) {
            console.log("Push notification send error:", error.message);
        }
    });

    // ================= WebRTC Call Signaling =================
    
    // ১. রিং বাজানোর সিগন্যাল
    socket.on('call_user', (data) => {
        if (data && data.room) {
            console.log(`Calling in room: ${data.room}`);
            socket.to(data.room).emit('incoming_call', {
                callerName: data.callerName,
                isVideo: data.isVideo,
                isGroup: data.isGroup,
                room: data.room 
            });
            
            try {
                const payload = {
                    title: `Incoming ${data.isVideo ? 'Video' : 'Audio'} Call`,
                    body: `${data.callerName} is calling you...`,
                    url: "/dashboard"
                };
            } catch(e) {}
        }
    });

    // ২. কল রিসিভ করার সিগন্যাল
    socket.on('answer_call', (data) => {
        if (data && data.room) {
            console.log(`Call answered in room: ${data.room}`);
            socket.to(data.room).emit('call_accepted', data.signal);
        }
    });

    // ৩. WebRTC Offer (যে কল রিসিভ করেছে তার কাছে যাবে)
    socket.on('webrtc_offer', (data) => {
        if (data && data.room) {
            socket.to(data.room).emit('webrtc_offer', data);
        }
    });

    // ৪. WebRTC Answer (যে কল করেছে তার কাছে যাবে)
    socket.on('webrtc_answer', (data) => {
        if (data && data.room) {
            socket.to(data.room).emit('webrtc_answer', data);
        }
    });

    // ৫. ICE Candidate (পিয়ার-টু-পিয়ার নেটওয়ার্ক কানেকশন)
    socket.on('webrtc_ice_candidate', (data) => {
        if (data && data.room) {
            socket.to(data.room).emit('webrtc_ice_candidate', data);
        }
    });

    // ৬. কল এন্ড
    socket.on('end_call', (data) => {
        if (data && data.room) {
            console.log(`Call ended by user in room: ${data.room}`);
            socket.to(data.room).emit('call_ended');
        }
    });

    socket.on('disconnect', () => {
        console.log(`🚫 User disconnected: ${socket.id}`);
        if (currentUserName) {
            onlineUsers.delete(socket.id);
            io.emit('online_users', Array.from(onlineUsers.values()));
        }
    });
});

const MONGO_URI = process.env.MONGO_URI || "mongodb+srv://nasimsharkarofficial_db_user:AgencyNasim2026@fortivus-group-llc.3iqgbfe.mongodb.net/?retryWrites=true&w=majority";

mongoose.connect(MONGO_URI)
    .then(() => console.log('✅ MongoDB is Connected Successfully!'))
    .catch((err) => {
        console.log('❌ DB Connection Error:', err.message);
    });

const PORT = process.env.PORT || 8080;

server.listen(PORT, () => {
    console.log(`🚀 Server is running on port ${PORT}`);
});