const express = require('express');
const router = express.Router();
const Client = require('../models/Client');

// Add new client
router.post('/', async (req, res) => {
    try {
        const newClient = new Client(req.body);
        const savedClient = await newClient.save();
        res.status(201).json(savedClient);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// Get all clients
router.get('/', async (req, res) => {
    try {
        const clients = await Client.find().sort({ createdAt: -1 });
        res.status(200).json(clients);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// Edit/Update a client
router.put('/:id', async (req, res) => {
    try {
        const updatedClient = await Client.findByIdAndUpdate(req.params.id, req.body, { new: true });
        res.status(200).json(updatedClient);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// Delete client
router.delete('/:id', async (req, res) => {
    try {
        await Client.findByIdAndDelete(req.params.id);
        res.status(200).json("Client deleted.");
    } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;