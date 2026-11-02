const { seedDefaultPlans } = require('./planService');
const { syncLegacyTenantsAndUsers } = require('./tenantService');

const bootstrapDatabase = async () => {
  await seedDefaultPlans();
  await syncLegacyTenantsAndUsers();
};

module.exports = {
  bootstrapDatabase,
};
