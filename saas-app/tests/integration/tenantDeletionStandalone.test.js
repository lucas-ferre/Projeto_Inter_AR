const { after, before, describe, it } = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const Tenant = require('../../models/Tenant');
const User = require('../../models/User');
const { deleteTenant } = require('../../services/tenantService');

const mongoUri = process.env.STANDALONE_MONGO_URI;

if (!mongoUri) {
  throw new Error('STANDALONE_MONGO_URI deve apontar para uma instância MongoDB standalone.');
}

const waitForTenantDeletion = async (tenantId, timeoutMs = 6000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const tenant = await Tenant.exists({ _id: tenantId });
    if (!tenant) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return false;
};

describe('tenant deletion on MongoDB standalone', () => {
  before(async () => {
    await mongoose.connect(mongoUri, { serverSelectionTimeoutMS: 5000 });
    assert.equal(mongoose.connection.client.topology.description.type, 'Single');
    await mongoose.connection.db.dropDatabase();
    await mongoose.syncIndexes();
  });

  after(async () => {
    if (mongoose.connection.readyState === 1) {
      await mongoose.connection.db.dropDatabase();
      await mongoose.connection.close();
    }
  });

  it('deletes a tenant and its users through the standalone two-phase path', async () => {
    const tenant = await Tenant.create({ name: 'Standalone Delete Success' });
    await User.create({
      name: 'Tenant Admin',
      email: 'admin-success@standalone.test',
      password: 'hashed-password-placeholder',
      role: 'admin',
      tenantId: String(tenant._id),
    });

    const result = await deleteTenant(tenant._id);

    assert.equal(result.deletedUsersCount, 1);
    assert.equal(await Tenant.exists({ _id: tenant._id }), null);
    assert.equal(await User.countDocuments({ tenantId: String(tenant._id) }), 0);
  });

  it('retries and reconciles a partial deletion after a transient user cleanup failure', async () => {
    const tenant = await Tenant.create({ name: 'Standalone Delete Retry' });
    await User.create({
      name: 'Tenant Admin',
      email: 'admin-retry@standalone.test',
      password: 'hashed-password-placeholder',
      role: 'admin',
      tenantId: String(tenant._id),
    });

    const originalDeleteMany = User.deleteMany;
    let failOnce = true;
    User.deleteMany = function (...args) {
      if (failOnce) {
        failOnce = false;
        return Promise.reject(new Error('simulated transient cleanup failure'));
      }
      return originalDeleteMany.apply(this, args);
    };

    try {
      await assert.rejects(deleteTenant(tenant._id), /simulated transient cleanup failure/);
    } finally {
      User.deleteMany = originalDeleteMany;
    }

    assert.equal(await waitForTenantDeletion(tenant._id), true);
    assert.equal(await User.countDocuments({ tenantId: String(tenant._id) }), 0);
  });
});
