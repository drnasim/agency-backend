const jwt = require('jsonwebtoken');
const User = require('../models/User');

const getJwtSecret = () => {
    const secret = String(process.env.JWT_SECRET || '').trim();
    if (!secret) throw new Error('JWT_SECRET is required for authenticated push notification APIs');
    return secret;
};

const createAuthToken = (user) => jwt.sign(
    { sub: user._id.toString() },
    getJwtSecret(),
    { expiresIn: process.env.JWT_EXPIRES_IN || '7d' }
);

const authenticate = async (req, res, next) => {
    try {
        const authorization = String(req.get('authorization') || '');
        const match = authorization.match(/^Bearer\s+(.+)$/i);
        if (!match) return res.status(401).json({ error: 'Authentication required' });

        const payload = jwt.verify(match[1], getJwtSecret());
        const user = await User.findOne({ _id: payload.sub, isActive: { $ne: false } })
            .select('_id name email role isActive');

        if (!user) return res.status(401).json({ error: 'Session is no longer valid' });
        req.user = user;
        return next();
    } catch (error) {
        if (error.name === 'JsonWebTokenError' || error.name === 'TokenExpiredError') {
            return res.status(401).json({ error: 'Session is invalid or expired' });
        }
        console.error('Push authentication error:', error.message);
        return res.status(500).json({ error: 'Authentication is unavailable' });
    }
};

module.exports = { authenticate, createAuthToken, getJwtSecret };
