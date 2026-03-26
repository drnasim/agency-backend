require('dotenv').config(); // এটি সবার উপরে থাকবে
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const http = require('http'); 
const { Server } = require('socket.io'); 

const app = express();
const server = http.createServer(app); 

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

// অনলাইন ইউজারদের ট্র্যাক করার জন্য Map (নতুন যোগ করা হয়েছে)
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

    socket.on('join_room', (data) => {
        socket.join(data);
        console.log(`User ${socket.id} joined room: ${data}`);
    });

    socket.on('send_message', (data) => {
        socket.to(data.room).emit('receive_message', data);
    });

    socket.on('disconnect', () => {
        console.log(`🚫 User disconnected: ${socket.id}`);
        // ইউজার বের হয়ে গেলে অনলাইন লিস্ট থেকে রিমুভ করা এবং সবাইকে জানানো
        onlineUsers.delete(socket.id);
        io.emit('online_users', Array.from(onlineUsers.values()));
    });
});

// MongoDB কানেকশন (সঠিক ক্লাস্টার আইডি 3iqgbfe ব্যবহার করা হয়েছে)
const MONGO_URI = process.env.MONGO_URI || "mongodb+srv://nasimsharkarofficial_db_user:AgencyNasim2026@fortivus-group-llc.3iqgbfe.mongodb.net/?retryWrites=true&w=majority";

mongoose.connect(MONGO_URI)
    .then(() => console.log('✅ MongoDB is Connected Successfully!'))
    .catch((err) => {
        console.log('❌ DB Connection Error:', err.message);
    });

// পোর্ট সেটআপ (রেলওয়ে এটি অটো-ম্যানেজ করবে)
const PORT = process.env.PORT || 8080;

server.listen(PORT, () => {
    console.log(`🚀 Server is running on port ${PORT}`);
});