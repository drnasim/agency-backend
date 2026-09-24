const User = require('../models/User');
const Client = require('../models/Client');

const read = async (req, res) => {
    try {
        const user = await User.findById(req.user._id).select('lastProjectClient');
        return res.json({ clientId: user?.lastProjectClient?.toString() || '' });
    } catch (error) {
        console.error('Could not load project client preference:', error);
        return res.status(500).json({ error: 'Could not load the last selected client' });
    }
};

const write = async (req, res) => {
    const clientId = req.body?.clientId;
    if (typeof clientId !== 'string' || !/^[a-f0-9]{24}$/i.test(clientId)) {
        return res.status(400).json({ error: 'A valid client ID is required' });
    }
    try {
        if (!await Client.exists({ _id: clientId })) {
            return res.status(404).json({ error: 'Client not found' });
        }
        await User.updateOne({ _id: req.user._id }, { $set: { lastProjectClient: clientId } });
        return res.json({ clientId });
    } catch (error) {
        console.error('Could not save project client preference:', error);
        return res.status(500).json({ error: 'Could not remember the selected client' });
    }
};

module.exports = { read, write };
