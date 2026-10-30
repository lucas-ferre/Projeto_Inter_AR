const mongoose = require('mongoose');
const Tenant = require('../models/Tenant');
const User = require('../models/User');
const { createOperationalError } = require('./errors');
const { getPlanByName } = require('./planService');

const { TENANT_NAME_COLLATION } = Tenant;
const DEFAULT_PAGE_LIMIT = 50;
const MAX_PAGE_LIMIT = 100;

const isTransactionUnsupportedError = (error) =>
  Boolean(
    error &&
      (error.code === 20 ||
        /Transaction numbers are only allowed on a replica set member or mongos|transactions are not supported|does not support retryable writes/i.test(
          error.message || ''
        ))
  );

const supportsTransactions = () => {
  const topologyType = mongoose.connection?.client?.topology?.description?.type;
  return topologyType === 'ReplicaSetWithPrimary' || topologyType === 'Sharded';
};

const normalizePagination = ({ page, limit } = {}) => {
  const parsedPage = page !== undefined ? Number(page) : 1;
  const parsedLimit = limit !== undefined ? Number(limit) : DEFAULT_PAGE_LIMIT;

  if (!Number.isInteger(parsedPage) || parsedPage < 1) {
    throw createOperationalError('O parâmetro page deve ser um inteiro maior ou igual a 1.', 400);
  }

  if (!Number.isInteger(parsedLimit) || parsedLimit < 1 || parsedLimit > MAX_PAGE_LIMIT) {
    throw createOperationalError(
      `O parâmetro limit deve ser um inteiro entre 1 e ${MAX_PAGE_LIMIT}.`,
      400
    );
  }

  return {
    page: parsedPage,
    limit: parsedLimit,
    skip: (parsedPage - 1) * parsedLimit,
  };
};

const reconcilePendingTenantDeletions = async () => {
  let cleanedTenants = 0;
  let cleanedOrphanUsers = 0;

  const pendingTenants = await Tenant.find({ status: 'deleting' }).select('_id').lean();
  for (const pending of pendingTenants) {
    const delUsers = await User.deleteMany({ tenantId: String(pending._id) });
    cleanedOrphanUsers += delUsers.deletedCount || 0;
    await Tenant.findByIdAndDelete(pending._id);
    cleanedTenants += 1;
  }

  const distinctUserTenantIds = await User.distinct('tenantId');
  const validObjectIds = distinctUserTenantIds.filter((id) => mongoose.isValidObjectId(String(id)));
  const invalidTenantIds = distinctUserTenantIds.filter(
    (id) => !mongoose.isValidObjectId(String(id))
  );

  if (invalidTenantIds.length > 0) {
    const res = await User.deleteMany({ tenantId: { $in: invalidTenantIds } });
    cleanedOrphanUsers += res.deletedCount || 0;
  }

  if (validObjectIds.length > 0) {
    const existingTenants = await Tenant.find({ _id: { $in: validObjectIds } })
      .select('_id')
      .lean();
    const existingIdSet = new Set(existingTenants.map((t) => String(t._id)));
    const orphanTenantIds = validObjectIds.filter((id) => !existingIdSet.has(String(id)));

    if (orphanTenantIds.length > 0) {
      const res = await User.deleteMany({ tenantId: { $in: orphanTenantIds.map(String) } });
      cleanedOrphanUsers += res.deletedCount || 0;
    }
  }

  return { cleanedTenants, cleanedOrphanUsers };
};

const syncLegacyTenantsAndUsers = async () => {
  try {
    const existingUserIndexes = await User.collection.indexes();
    const legacyGlobalEmailUnique = existingUserIndexes.find(
      (idx) => idx.name === 'email_1' && idx.unique
    );
    if (legacyGlobalEmailUnique) {
      await User.collection.dropIndex('email_1');
      await User.createIndexes();
    }
  } catch {
    // Ignora caso a coleção users ainda não exista no banco recém-criado
  }

  const legacyTenants = await Tenant.find({
    $or: [{ userCount: { $exists: false } }, { status: { $exists: false } }],
  }).lean();

  for (const legacyTenant of legacyTenants) {
    const tenantId = String(legacyTenant._id);
    const count = await User.countDocuments({ tenantId });
    await Tenant.updateOne(
      { _id: legacyTenant._id },
      {
        $set: {
          status: legacyTenant.status || 'active',
          userCount: typeof legacyTenant.userCount === 'number' ? legacyTenant.userCount : count,
          initializedAt:
            legacyTenant.initializedAt !== undefined
              ? legacyTenant.initializedAt
              : count > 0
                ? legacyTenant.createdAt || new Date()
                : null,
        },
      }
    );
  }

  const legacyUsersTenantIds = await User.distinct('tenantId', { role: { $exists: false } });
  for (const tenantId of legacyUsersTenantIds) {
    const hasAdmin = await User.exists({ tenantId, role: 'admin' });
    if (!hasAdmin) {
      const oldestUser = await User.findOne({ tenantId }).sort({ createdAt: 1, _id: 1 });
      if (oldestUser) {
        await User.updateOne({ _id: oldestUser._id }, { $set: { role: 'admin' } });
      }
    }
    await User.updateMany({ tenantId, role: { $exists: false } }, { $set: { role: 'member' } });
  }

  await reconcilePendingTenantDeletions();
};

const ensureTenantCounterSynced = async (tenantId) => {
  const rawTenant = await Tenant.collection.findOne({ _id: new mongoose.Types.ObjectId(tenantId) });
  if (!rawTenant || rawTenant.status === 'deleting') {
    return null;
  }

  if (typeof rawTenant.userCount !== 'number') {
    const actualCount = await User.countDocuments({ tenantId: String(tenantId) });
    await Tenant.updateOne(
      { _id: rawTenant._id, userCount: { $exists: false } },
      {
        $set: {
          status: rawTenant.status || 'active',
          userCount: actualCount,
          initializedAt: actualCount > 0 ? rawTenant.createdAt || new Date() : null,
        },
      }
    );
  }

  return Tenant.findOne({ _id: tenantId, status: { $ne: 'deleting' } });
};

exports.createTenant = async ({ name, plan = 'freemium' }) => {
  if (typeof name !== 'string' || name.trim().length < 2 || name.trim().length > 120) {
    throw createOperationalError('O nome do tenant deve ter entre 2 e 120 caracteres.', 400);
  }

  const normalizedName = name.trim();
  const planDoc = await getPlanByName(plan);

  const existingTenant = await Tenant.findOne({ name: normalizedName }).collation(
    TENANT_NAME_COLLATION
  );

  if (existingTenant) {
    throw createOperationalError('Não foi possível criar o tenant com os dados informados.', 409);
  }

  try {
    const tenant = await Tenant.create({
      name: normalizedName,
      plan: planDoc.name,
      status: 'active',
      userCount: 0,
      initializedAt: null,
    });

    return tenant;
  } catch (error) {
    if (error.code === 11000) {
      throw createOperationalError('Não foi possível criar o tenant com os dados informados.', 409);
    }
    throw error;
  }
};

exports.listTenantsByUser = async (userTenantId) => {
  const tenant = await exports.getTenantById(userTenantId);
  return [tenant];
};

exports.getTenantById = async (tenantId) => {
  if (!mongoose.isValidObjectId(String(tenantId))) {
    throw createOperationalError('ID do tenant inválido.', 400);
  }

  const tenant = await Tenant.findOne({ _id: tenantId, status: { $ne: 'deleting' } });

  if (!tenant) {
    throw createOperationalError('Tenant não encontrado.', 404);
  }

  return tenant;
};

exports.getTenantUsers = async (tenantId, pagination = {}) => {
  await exports.getTenantById(tenantId);
  const { page, limit, skip } = normalizePagination(pagination);
  const normalizedTenantId = String(tenantId);

  const [users, total] = await Promise.all([
    User.find({ tenantId: normalizedTenantId })
      .sort({ createdAt: -1, _id: -1 })
      .skip(skip)
      .limit(limit),
    User.countDocuments({ tenantId: normalizedTenantId }),
  ]);

  return { users, total, page, limit };
};

exports.updateTenant = async (tenantId, payload) => {
  const tenant = await exports.getTenantById(tenantId);
  const { name, plan } = payload || {};

  if (name === undefined && plan === undefined) {
    throw createOperationalError('Informe ao menos um campo para atualização (name ou plan).', 400);
  }

  if (name !== undefined) {
    if (typeof name !== 'string' || name.trim().length < 2 || name.trim().length > 120) {
      throw createOperationalError('O nome do tenant deve ter entre 2 e 120 caracteres.', 400);
    }

    const trimmedName = name.trim();
    const exists = await Tenant.findOne({
      name: trimmedName,
      _id: { $ne: tenant._id },
    }).collation(TENANT_NAME_COLLATION);

    if (exists) {
      throw createOperationalError('Já existe um tenant com este nome.', 409);
    }

    tenant.name = trimmedName;
  }

  if (plan !== undefined) {
    const targetPlan = await getPlanByName(plan);

    if (targetPlan.name !== tenant.plan) {
      const allowDirectPlanChange = process.env.ALLOW_DIRECT_PLAN_CHANGE === 'true';
      if (!allowDirectPlanChange) {
        throw createOperationalError(
          'A alteração direta de plano não é permitida por esta rota.',
          403
        );
      }

      const currentUsers = await User.countDocuments({ tenantId: String(tenant._id) });
      if (targetPlan.maxUsers !== null && currentUsers > targetPlan.maxUsers) {
        throw createOperationalError(
          'Não é possível alterar para este plano pois o tenant possui mais usuários ativos do que o limite permitido.',
          409
        );
      }

      tenant.plan = targetPlan.name;
      tenant.userCount = currentUsers;
    }
  }

  try {
    await tenant.save();
    return tenant;
  } catch (error) {
    if (error.code === 11000) {
      throw createOperationalError('Já existe um tenant com este nome.', 409);
    }
    throw error;
  }
};

exports.deleteTenant = async (tenantId) => {
  if (!mongoose.isValidObjectId(String(tenantId))) {
    throw createOperationalError('ID do tenant inválido.', 400);
  }

  const normalizedTenantId = String(tenantId);

  // 1) Tenta exclusão atômica via transação ACID quando a topologia suporta transações (Replica Set / Sharded / Atlas)
  if (supportsTransactions()) {
    const session = await mongoose.startSession();
    try {
      let transactionResult = null;
      await session.withTransaction(async () => {
        const deletedTenant = await Tenant.findOneAndDelete({ _id: tenantId }, { session });
        if (!deletedTenant) {
          throw createOperationalError('Tenant não encontrado.', 404);
        }

        const deleteResult = await User.deleteMany({ tenantId: normalizedTenantId }, { session });
        transactionResult = {
          deletedTenantId: deletedTenant._id,
          deletedUsers: true,
          deletedUsersCount: deleteResult.deletedCount,
        };
      });

      return transactionResult;
    } catch (error) {
      if (!isTransactionUnsupportedError(error)) {
        throw error;
      }
    } finally {
      await session.endSession();
    }
  }

  // 2) Fallback seguro em duas fases (tombstone 'deleting' + reconciliação) para MongoDB standalone
  const tombstoneTenant = await Tenant.findOneAndUpdate(
    { _id: tenantId },
    { $set: { status: 'deleting' } },
    { returnDocument: 'after' }
  );

  if (!tombstoneTenant) {
    throw createOperationalError('Tenant não encontrado.', 404);
  }

  try {
    const deleteResult = await User.deleteMany({ tenantId: normalizedTenantId });
    await Tenant.findByIdAndDelete(tenantId);

    return {
      deletedTenantId: tombstoneTenant._id,
      deletedUsers: true,
      deletedUsersCount: deleteResult.deletedCount,
    };
  } catch (cleanupError) {
    // Mantém status='deleting' bloqueando acessos e agenda tentativa automática de reconciliação
    const timer = setTimeout(() => {
      reconcilePendingTenantDeletions().catch(() => {});
    }, 1000);
    if (typeof timer.unref === 'function') {
      timer.unref();
    }
    throw cleanupError;
  }
};

exports.reserveUserSlot = async (tenantId, { initialPublicRegister = false } = {}) => {
  if (!mongoose.isValidObjectId(String(tenantId))) {
    throw createOperationalError('O tenantId informado é inválido.', 400);
  }

  const tenant = await ensureTenantCounterSynced(tenantId);
  if (!tenant) {
    if (initialPublicRegister) {
      throw createOperationalError(
        'Não foi possível concluir o registro com os dados informados.',
        400
      );
    }
    throw createOperationalError('Tenant não encontrado.', 404);
  }

  const planDoc = await getPlanByName(tenant.plan);
  const maxUsers = planDoc.maxUsers;
  const allowPublicMultiRegister = process.env.ALLOW_PUBLIC_MULTI_REGISTER === 'true';

  if (initialPublicRegister && !allowPublicMultiRegister) {
    if (tenant.userCount > 0 || tenant.initializedAt !== null) {
      throw createOperationalError(
        'Não foi possível concluir o registro com os dados informados.',
        403
      );
    }

    if (maxUsers !== null && maxUsers < 1) {
      throw createOperationalError('Limite de usuários atingido para este plano.', 403);
    }

    const reserved = await Tenant.findOneAndUpdate(
      { _id: tenant._id, status: { $ne: 'deleting' }, userCount: 0, initializedAt: null },
      { $inc: { userCount: 1 }, $set: { initializedAt: new Date() } },
      { returnDocument: 'after' }
    );

    if (!reserved) {
      throw createOperationalError(
        'Não foi possível concluir o registro com os dados informados.',
        403
      );
    }

    return {
      tenant: reserved,
      wasInitialSlot: true,
      assignedRole: 'admin',
    };
  }

  if (maxUsers !== null && tenant.userCount >= maxUsers) {
    throw createOperationalError('Limite de usuários atingido para este plano.', 403);
  }

  const filter = {
    _id: tenant._id,
    status: { $ne: 'deleting' },
    plan: tenant.plan,
    ...(maxUsers !== null ? { userCount: { $lt: maxUsers } } : {}),
  };

  const shouldMarkInitialized = tenant.userCount === 0 && tenant.initializedAt === null;
  const update = {
    $inc: { userCount: 1 },
    ...(shouldMarkInitialized ? { $set: { initializedAt: new Date() } } : {}),
  };

  const reserved = await Tenant.findOneAndUpdate(filter, update, { returnDocument: 'after' });
  if (!reserved) {
    const stillExists = await Tenant.exists({ _id: tenant._id, status: { $ne: 'deleting' } });
    if (!stillExists) {
      throw createOperationalError('Tenant não encontrado.', 404);
    }
    throw createOperationalError('Limite de usuários atingido para este plano.', 403);
  }

  return {
    tenant: reserved,
    wasInitialSlot: shouldMarkInitialized,
    assignedRole: reserved.userCount === 1 ? 'admin' : 'member',
  };
};

exports.releaseUserSlot = async (tenantId, { wasInitialSlot = false } = {}) => {
  if (wasInitialSlot) {
    const resetResult = await Tenant.updateOne(
      { _id: tenantId, userCount: 1 },
      { $set: { userCount: 0, initializedAt: null } }
    );
    if (resetResult.matchedCount > 0) {
      return;
    }
  }

  await Tenant.updateOne({ _id: tenantId, userCount: { $gt: 0 } }, { $inc: { userCount: -1 } });
};

exports.reconcilePendingTenantDeletions = reconcilePendingTenantDeletions;
exports.syncLegacyTenantsAndUsers = syncLegacyTenantsAndUsers;
