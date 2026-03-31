const express = require('express');
const router = express.Router();
const mongoose = require('mongoose');

// Expense Database Schema & Model
const expenseSchema = new mongoose.Schema({
    name: { type: String, required: true },
    amount: { type: Number, required: true },
    type: { type: String, enum: ['Regular', 'One-time'], required: true },
    month: { type: String, required: true }, // ফরমেট: "YYYY-MM"
    createdAt: { type: Date, default: Date.now }
});

const Expense = mongoose.models.Expense || mongoose.model('Expense', expenseSchema);

// আগের মাস বের করার হেল্পার ফাংশন
const getPreviousMonth = (currentMonthStr) => {
    const [year, month] = currentMonthStr.split('-');
    let date = new Date(year, parseInt(month) - 1, 1);
    date.setMonth(date.getMonth() - 1);
    const prevYear = date.getFullYear();
    const prevMonth = String(date.getMonth() + 1).padStart(2, '0');
    return `${prevYear}-${prevMonth}`;
};

// GET /api/finance/expenses?month=YYYY-MM
router.get('/expenses', async (req, res) => {
    try {
        const { month } = req.query;
        if (!month) return res.status(400).json({ error: "Month parameter is required" });

        let expenses = await Expense.find({ month });

        // অটো-ক্যারি ওভার লজিক: যদি এই মাসে কোনো খরচ না থাকে, আগের মাসের 'Regular' খরচগুলো নিয়ে আসবে
        if (expenses.length === 0) {
            const prevMonth = getPreviousMonth(month);
            const prevRegularExpenses = await Expense.find({ month: prevMonth, type: 'Regular' });

            if (prevRegularExpenses.length > 0) {
                const newExpenses = prevRegularExpenses.map(exp => ({
                    name: exp.name,
                    amount: exp.amount,
                    type: exp.type,
                    month: month
                }));
                // নতুন মাসে ইনসার্ট করা হচ্ছে
                await Expense.insertMany(newExpenses);
                // ইনসার্ট করার পর আবার নতুন করে ফেচ করা হচ্ছে আইডি সহ পাওয়ার জন্য
                expenses = await Expense.find({ month }); 
            }
        }

        res.status(200).json(expenses);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// POST /api/finance/expenses
router.post('/expenses', async (req, res) => {
    try {
        const { name, amount, type, month } = req.body;
        if (!name || !amount || !type || !month) {
            return res.status(400).json({ error: "All fields are required" });
        }

        const newExpense = new Expense({ name, amount, type, month });
        await newExpense.save();
        res.status(201).json(newExpense);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// PUT /api/finance/expenses/:id
router.put('/expenses/:id', async (req, res) => {
    try {
        const { name, amount, type } = req.body;
        const updatedExpense = await Expense.findByIdAndUpdate(
            req.params.id, 
            { name, amount, type }, 
            { new: true } // আপডেট হওয়া নতুন ডেটা রিটার্ন করবে
        );
        
        if (!updatedExpense) return res.status(404).json({ error: "Expense not found" });
        res.status(200).json(updatedExpense);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// DELETE /api/finance/expenses/:id
router.delete('/expenses/:id', async (req, res) => {
    try {
        const deletedExpense = await Expense.findByIdAndDelete(req.params.id);
        if (!deletedExpense) return res.status(404).json({ error: "Expense not found" });
        res.status(200).json({ message: "Expense deleted successfully" });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

module.exports = router;