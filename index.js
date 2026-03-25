const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const http = require('http'); 
const { Server } = require('socket.io'); 
require('dotenv').config();

const app = express();
const server = http.createServer(app); 

// Socket.io সেটআপ (CORS পারমিশন সহ)
const io = new Server(server, {
    cors: {
        origin: "*", 
        methods: ["GET", "POST"]
    }
});

// Middleware
app.use(cors());
app.use(express.json());

// Routes কানেক্ট করা
const projectRoutes = require('./routes/projects');
const clientRoutes = require('./routes/clients');
const employeeRoutes = require('./routes/employees');
const authRoutes = require('./routes/auth');
const settingsRoutes = require('./routes/settings');
const driveRoutes = require('./routes/drive');
const chatRoutes = require('./routes/chat'); // নতুন চ্যাট রাউট

app.use('/api/projects', projectRoutes);
app.use('/api/clients', clientRoutes);
app.use('/api/employees', employeeRoutes);
app.use('/api/auth', authRoutes);
app.use('/api/settings', settingsRoutes);
app.use('/api/drive', driveRoutes);
app.use('/api/chat', chatRoutes); // চ্যাট API কানেক্ট করা হলো

// ================= Socket.io রিয়েল-টাইম ইভেন্ট =================
io.on('connection', (socket) => {
    console.log(`🔌 User connected: ${socket.id}`);

    // ইউজার কোনো চ্যাট রুমে (গ্রুপ বা প্রাইভেট) জয়েন করলে
    socket.on('join_room', (data) => {
        socket.join(data);
        console.log(`User ${socket.id} joined room: ${data}`);
    });

    // নতুন মেসেজ আসলে সেটা ওই রুমের সবাইকে পাঠিয়ে দেওয়া
    socket.on('send_message', (data) => {
        socket.to(data.room).emit('receive_message', data);
    });

    socket.on('disconnect', () => {
        console.log(`🚫 User disconnected: ${socket.id}`);
    });
});

// MongoDB কানেকশন
mongoose.connect(process.env.MONGO_URI)
    .then(() => console.log('✅ MongoDB is Connected Successfully!'))
    .catch((err) => console.log('❌ DB Connection Error:', err));

const PORT = process.env.PORT || 5001;

// app.listen এর বদলে server.listen ব্যবহার করতে হবে
server.listen(PORT, () => {
    console.log(`🚀 Server is running on port ${PORT}`);
});