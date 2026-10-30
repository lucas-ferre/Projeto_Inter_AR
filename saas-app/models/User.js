const mongoose = require('mongoose');

const sanitizeTransform = (doc, ret) => {
  delete ret.password;
  delete ret.__v;
  return ret;
};

const userSchema = new mongoose.Schema({
  name: {
    type: String,
    required: true,
    trim: true,
    minlength: 2,
    maxlength: 120,
  },
  email: {
    type: String,
    required: true,
    lowercase: true,
    trim: true,
    maxlength: 254,
  },
  password: {
    type: String,
    required: true,
    select: false,
  },
  role: {
    type: String,
    enum: ['admin', 'member'],
    default: 'member',
    required: true,
  },
  tenantId: {
    type: String,
    required: true,
    trim: true,
  },
}, {
  timestamps: true,
  toJSON: { transform: sanitizeTransform },
  toObject: { transform: sanitizeTransform },
});

// Unicidade de e-mail escopada por tenant (permite à mesma pessoa participar de tenants distintos)
userSchema.index({ tenantId: 1, email: 1 }, { unique: true, name: 'tenant_email_unique' });
userSchema.index({ email: 1 }, { name: 'email_lookup_idx' });
userSchema.index({ tenantId: 1, createdAt: -1 });
userSchema.index({ tenantId: 1, role: 1 });

module.exports = mongoose.model('User', userSchema);
