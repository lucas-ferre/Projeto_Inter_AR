const mongoose = require('mongoose');

const sanitizeTransform = (doc, ret) => {
  delete ret.__v;
  return ret;
};

const planSchema = new mongoose.Schema({
  name: {
    type: String,
    required: true,
    unique: true,
    lowercase: true,
    trim: true,
    minlength: 2,
    maxlength: 40,
  },
  maxUsers: {
    type: Number,
    default: null, // null representa usuários ilimitados
    min: 1,
  },
  price: {
    type: Number,
    required: true,
    min: 0,
  },
}, {
  timestamps: true,
  toJSON: { transform: sanitizeTransform },
  toObject: { transform: sanitizeTransform },
});

module.exports = mongoose.model('Plan', planSchema);
