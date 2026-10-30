const mongoose = require('mongoose');
const { seedDefaultPlans } = require('../services/planService');
const { syncLegacyTenantsAndUsers } = require('../services/tenantService');
const { sanitizeSensitiveText } = require('../middleware/errorHandler');

let listenersAttached = false;

const attachConnectionListeners = () => {
  if (listenersAttached) return;
  listenersAttached = true;

  mongoose.connection.on('error', (err) => {
    console.error('[MongoDB] Erro na conexão ativa:', sanitizeSensitiveText(err?.message));
  });
};

const connectDatabase = async (uri = process.env.MONGO_URI) => {
  if (!uri) {
    throw new Error('MONGO_URI não configurada no arquivo .env');
  }

  attachConnectionListeners();
  await mongoose.connect(uri);
  await seedDefaultPlans();
  await syncLegacyTenantsAndUsers();
  console.log('MongoDB conectado');
  return mongoose;
};

module.exports = {
  mongoose,
  connectDatabase,
};
