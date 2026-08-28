const jwt = require('jsonwebtoken');
const User = require('../models/User');

const getJwtSecret = () => {
    const secret = String(process.env.JWT_SECRET || '').trim();
    if (!secret) throw new Error('JWT_SECRET is required for authenticated APIs');
    return secret;
};

const createAuthToken = (user) => jwt.sign(
    { sub: user._id.toString() },
    getJwtSecret(),
    { expiresIn: process.env.JWT_EXPIRES_IN || '7d' }
);

const findUserForToken = async (token) => {
    const payload = jwt.verify(token, getJwtSecret());
    return User.findOne({ _id: payload.sub, isActive: { $ne: false } })
        .select('_id name email role isActive');
};

const authenticate = async (req, res, next) => {
    try {
        const authorization = String(req.get('authorization') || '');
        const match = authorization.match(/^Bearer\s+(.+)$/i);
        if (!match) return res.status(401).json({ error: 'Authentication required' });

        const user = await findUserForToken(match[1]);

        if (!user) return res.status(401).json({ error: 'Session is no longer valid' });
        req.user = user;
        return next();
    } catch (error) {
        if (error.name === 'JsonWebTokenError' || error.name === 'TokenExpiredError') {
            return res.status(401).json({ error: 'Session is invalid or expired' });
        }
        console.error('Authentication error:', error.message);
        return res.status(500).json({ error: 'Authentication is unavailable' });
    }
};

const requireAdmin = (req, res, next) => {
    const roles = Array.isArray(req.user?.role) ? req.user.role : [req.user?.role];
    if (!roles.includes('Admin')) {
        return res.status(403).json({ error: 'Admin access is required' });
    }
    return next();
};

// Existing chat sockets remain backwards compatible when they do not present a
// token. A client that explicitly claims an authenticated session must prove it
// before Socket.IO reports a successful connection; otherwise mobile clients
// could incorrectly show "Connected" without access to their private room.
const attachAuthenticatedSocketUser = async (socket, next) => {
    const token = String(socket.handshake?.auth?.token || '').trim();
    if (!token) return next();

    try {
        const user = await findUserForToken(token);
        if (!user) return next(new Error('Socket authentication failed'));
        socket.authenticatedUser = user;
        return next();
    } catch {
        return next(new Error('Socket authentication failed'));
    }
};

module.exports = {
    authenticate,
    attachAuthenticatedSocketUser,
    createAuthToken,
    findUserForToken,
    getJwtSecret,
    requireAdmin
};
