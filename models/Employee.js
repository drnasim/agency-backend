const mongoose = require('mongoose');

const employeeSchema = new mongoose.Schema({
    name: { 
        type: String, 
        required: true 
    },
    email: { 
        type: String, 
        required: true, 
        unique: true 
    },
    position: { 
        type: String, 
        default: 'Video Editor' 
    },
    salary: { 
        type: Number, 
        default: 0 
    }
}, { timestamps: true });

module.exports = mongoose.model('Employee', employeeSchema);