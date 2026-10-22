const express = require('express');
const { authenticate, requireAdmin } = require('../middleware/authenticate');
const overview = require('../services/adminOverview');
const router = express.Router();

router.get('/', authenticate, requireAdmin, async (req, res) => {
    res.set('Cache-Control', 'no-store');
    try {
        return res.json(await overview.getAdminOverview());
    } catch (error) {
        console.error('Admin overview failed:', error.message);
        return res.status(503).json({ error: 'Admin overview is temporarily unavailable' });
    }
});
module.exports = router;
