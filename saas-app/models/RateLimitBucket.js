const mongoose = require('mongoose');

const rateLimitBucketSchema = new mongoose.Schema({
  key: {
    type: String,
    required: true,
    unique: true,
  },
  count: {
    type: Number,
    required: true,
    default: 1,
  },
  resetAt: {
    type: Date,
    required: true,
  },
}, {
  versionKey: false,
});

// Remove automaticamente janelas expiradas no MongoDB via TTL
rateLimitBucketSchema.index({ resetAt: 1 }, { expireAfterSeconds: 0 });

module.exports = mongoose.model('RateLimitBucket', rateLimitBucketSchema);
