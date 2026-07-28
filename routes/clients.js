const express = require('express');
const router = express.Router();
const Client = require('../models/Client');
const Settings = require('../models/Settings');
const { authenticate, requireAdmin } = require('../middleware/authenticate');
const {
    buildClientWritePayload,
    buildLegacyGuidelines,
    hasStructuredGuidelineData,
    hasStructuredGuidelineFields
} = require('../utils/clientGuidelines');
const {
    canonicalizeGuidelineItemCategories,
    getGuidelineCategoryCatalog
} = require('../utils/guidelineCategories');

const getClientErrorStatus = (error) => (
    error?.statusCode ||
    (error?.name === 'ValidationError' || error?.name === 'CastError' ? 400 : 500)
);

const prepareClientWritePayload = async (
    body,
    existingClient = null,
    settingsModel = Settings
) => {
    const payload = buildClientWritePayload(body, existingClient);
    const structuredIsAuthoritative = (
        hasStructuredGuidelineFields(body) ||
        hasStructuredGuidelineData(existingClient)
    );
    if (!structuredIsAuthoritative) return payload;

    let items = Object.hasOwn(body || {}, 'guidelineItems')
        ? payload.guidelineItems
        : Array.from(existingClient?.guidelineItems || []);

    if (Array.isArray(items) && items.length) {
        const catalog = await getGuidelineCategoryCatalog(settingsModel);
        items = canonicalizeGuidelineItemCategories(items, catalog);
    }

    const additionalNotes = Object.hasOwn(payload, 'guidelineNotes')
        ? payload.guidelineNotes
        : String(existingClient?.guidelineNotes || '').trim();

    payload.guidelineItems = items;
    payload.guidelineNotes = additionalNotes;
    payload.guidelines = buildLegacyGuidelines(items, additionalNotes);
    return payload;
};

// Add new client
router.post('/', authenticate, requireAdmin, async (req, res) => {
    try {
        const payload = await prepareClientWritePayload(req.body);
        const newClient = new Client(payload);
        const savedClient = await newClient.save();
        res.status(201).json(savedClient);
    } catch (err) {
        res.status(getClientErrorStatus(err)).json({ error: err.message });
    }
});

// Get all clients
router.get('/', async (req, res) => {
    try {
        const clients = await Client.find().sort({ createdAt: -1 });
        res.status(200).json(clients);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// Edit/Update a client
router.put('/:id', authenticate, requireAdmin, async (req, res) => {
    try {
        const existingClient = await Client.findById(req.params.id);
        if (!existingClient) return res.status(404).json({ error: 'Client not found' });

        const payload = await prepareClientWritePayload(req.body, existingClient);
        const updatedClient = await Client.findByIdAndUpdate(
            req.params.id,
            payload,
            { new: true, runValidators: true }
        );
        if (!updatedClient) return res.status(404).json({ error: 'Client not found' });
        res.status(200).json(updatedClient);
    } catch (err) {
        res.status(getClientErrorStatus(err)).json({ error: err.message });
    }
});

// Delete client
router.delete('/:id', authenticate, requireAdmin, async (req, res) => {
    try {
        await Client.findByIdAndDelete(req.params.id);
        res.status(200).json("Client deleted.");
    } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
module.exports.buildClientWritePayload = buildClientWritePayload;
module.exports.getClientErrorStatus = getClientErrorStatus;
module.exports.prepareClientWritePayload = prepareClientWritePayload;
