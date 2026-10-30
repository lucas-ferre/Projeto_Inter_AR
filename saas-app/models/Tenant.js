const mongoose = require('mongoose');

const TENANT_NAME_COLLATION = { locale: 'pt', strength: 2 };

const sanitizeTransform = (doc, ret) => {
  delete ret.__v;
  delete ret.userCount;
  delete ret.initializedAt;
  delete ret.status;
  return ret;
};

const tenantSchema = new mongoose.Schema({
  name: {
    type: String,
    required: true,
    trim: true,
    minlength: 2,
    maxlength: 120,
  },
  plan: {
    type: String,
    required: true,
    lowercase: true,
    trim: true,
    default: 'freemium',
  },
  status: {
    type: String,
    enum: ['active', 'deleting'],
    default: 'active',
    index: true,
  },
  userCount: {
    type: Number,
    default: 0,
    min: 0,
  },
  initializedAt: {
    type: Date,
    default: null,
  },
}, {
  timestamps: true,
  toJSON: { transform: sanitizeTransform },
  toObject: { transform: sanitizeTransform },
});

tenantSchema.index(
  { name: 1 },
  { unique: true, name: 'name_ci_unique', collation: TENANT_NAME_COLLATION }
);

const Tenant = mongoose.model('Tenant', tenantSchema);
Tenant.TENANT_NAME_COLLATION = TENANT_NAME_COLLATION;

module.exports = Tenant;
