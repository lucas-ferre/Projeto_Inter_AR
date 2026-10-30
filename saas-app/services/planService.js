const Plan = require('../models/Plan');
const { createOperationalError } = require('./errors');

const DEFAULT_PLANS = [
  { name: 'freemium', maxUsers: 3, price: 0 },
  { name: 'premium', maxUsers: null, price: 99.9 },
];

const seedDefaultPlans = async () => {
  const operations = DEFAULT_PLANS.map((plan) => ({
    updateOne: {
      filter: { name: plan.name },
      update: { $setOnInsert: plan },
      upsert: true,
    },
  }));

  await Plan.bulkWrite(operations, { ordered: false });
};

const listPlans = async () => {
  let plans = await Plan.find().sort({ price: 1, name: 1 });
  if (plans.length === 0) {
    await seedDefaultPlans();
    plans = await Plan.find().sort({ price: 1, name: 1 });
  }
  return plans;
};

const getPlanByName = async (planName) => {
  if (typeof planName !== 'string' || !planName.trim()) {
    throw createOperationalError('O plano é obrigatório.', 400);
  }

  const normalizedName = planName.trim().toLowerCase();
  let plan = await Plan.findOne({ name: normalizedName });

  if (!plan) {
    const totalPlans = await Plan.estimatedDocumentCount();
    if (totalPlans === 0) {
      await seedDefaultPlans();
      plan = await Plan.findOne({ name: normalizedName });
    }
  }

  if (!plan) {
    throw createOperationalError('O plano informado é inválido.', 400);
  }

  return plan;
};

module.exports = {
  seedDefaultPlans,
  listPlans,
  getPlanByName,
};
