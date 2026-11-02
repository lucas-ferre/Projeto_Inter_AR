const mongoose = require('mongoose');
const crypto = require('crypto');
const Tenant = require('../models/Tenant');
const User = require('../models/User');
const { createOperationalError } = require('./errors');
const { getPlanByName } = require('./planService');
const { sanitizeSensitiveText } = require('../middleware/errorHandler');

const { TENANT_NAME_COLLATION } = Tenant;
const DEFAULT_PAGE_LIMIT = 50;
const MAX_PAGE_LIMIT = 100;
const MAX_RECONCILIATION_RETRIES = 3;

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

const buildExpiredUninitializedCondition = (now = new Date()) => ({
  userCount: 0,
  initializedAt: null,
  $or: [
    { registrationTokenHash: { $exists: false } },
    { registrationTokenHash: null },
    { registrationTokenExpiresAt: { $exists: false } },
    { registrationTokenExpiresAt: null },
    { registrationTokenExpiresAt: { $lte: now } },
  ],
});

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

  const expiredUninitialized = await Tenant.find({
    status: { $ne: 'deleting' },
    ...buildExpiredUninitializedCondition(new Date()),
  })
    .select('_id')
    .lean();

  for (const candidate of expiredUninitialized) {
    const hasUsers = await User.exists({ tenantId: String(candidate._id) });
    if (!hasUsers) {
      const removed = await Tenant.deleteOne({
        _id: candidate._id,
        status: { $ne: 'deleting' },
        ...buildExpiredUninitializedCondition(new Date()),
      });
      cleanedTenants += removed.deletedCount || 0;
    }
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

const schedulePendingTenantReconciliation = (attempt = 1) => {
  const delayMs = Math.min(1000 * 2 ** (attempt - 1), 5000);
  const timer = setTimeout(async () => {
    const startedAt = Date.now();
    try {
      const result = await reconcilePendingTenantDeletions();
      console.info(
        `[TenantCleanup] outcome=success tentativa=${attempt} duraçãoMs=${Date.now() - startedAt} tenantsRemovidos=${result.cleanedTenants} usuariosOrfaosRemovidos=${result.cleanedOrphanUsers}`
      );
    } catch (error) {
      console.error(
        `[TenantCleanup] outcome=failure tentativa=${attempt}/${MAX_RECONCILIATION_RETRIES} duraçãoMs=${Date.now() - startedAt}:`,
        sanitizeSensitiveText(error?.message || 'Falha inesperada')
      );

      if (attempt < MAX_RECONCILIATION_RETRIES) {
        schedulePendingTenantReconciliation(attempt + 1);
      } else {
        console.error(
          '[TenantCleanup] A exclusão pendente permanece bloqueada e será reavaliada na próxima inicialização.'
        );
      }
    }
  }, delayMs);

  if (typeof timer.unref === 'function') {
    timer.unref();
  }
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
  } catch (error) {
    if (error?.code !== 26 && !/namespace not found|ns does not exist/i.test(error?.message || '')) {
      throw error;
    }
  }

  const legacyTenants = await Tenant.find({
    $or: [
      { userCount: { $exists: false } },
      { userCount: null },
      { adminCount: { $exists: false } },
      { adminCount: null },
      { status: { $exists: false } },
    ],
  })
    .select('+adminCount')
    .lean();

  for (const legacyTenant of legacyTenants) {
    const tenantId = String(legacyTenant._id);
    const count = await User.countDocuments({ tenantId });
    const adminCount =
      typeof legacyTenant.adminCount === 'number'
        ? legacyTenant.adminCount
        : await User.countDocuments({ tenantId, role: 'admin' });
    await Tenant.updateOne(
      { _id: legacyTenant._id },
      {
        $set: {
          status: legacyTenant.status || 'active',
          userCount: typeof legacyTenant.userCount === 'number' ? legacyTenant.userCount : count,
          adminCount,
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

    if (mongoose.isValidObjectId(String(tenantId))) {
      const adminCount = await User.countDocuments({ tenantId, role: 'admin' });
      await Tenant.updateOne({ _id: String(tenantId) }, { $set: { adminCount } });
    }
  }

  const reconciliationStartedAt = Date.now();
  try {
    const reconciledCounters = await reconcileTenantCounters();
    const cleanupResult = await reconcilePendingTenantDeletions();
    console.info(
      `[TenantCleanup] outcome=startup-success duraçãoMs=${Date.now() - reconciliationStartedAt} contadoresCorrigidos=${reconciledCounters} tenantsRemovidos=${cleanupResult.cleanedTenants} usuariosOrfaosRemovidos=${cleanupResult.cleanedOrphanUsers}`
    );
  } catch (error) {
    console.error(
      `[TenantCleanup] outcome=startup-failure duraçãoMs=${Date.now() - reconciliationStartedAt}:`,
      sanitizeSensitiveText(error?.message || 'Falha inesperada')
    );
    throw error;
  }
};

const reconcileTenantCounters = async () => {
  const userCountRows = await User.aggregate([
    {
      $group: {
        _id: '$tenantId',
        userCount: { $sum: 1 },
        adminCount: {
          $sum: { $cond: [{ $eq: ['$role', 'admin'] }, 1, 0] },
        },
      },
    },
  ]).allowDiskUse(true);
  const countByTenant = new Map(
    userCountRows.map((row) => [String(row._id), { userCount: row.userCount, adminCount: row.adminCount }])
  );
  const tenants = await Tenant.find({ status: { $ne: 'deleting' } })
    .select('_id userCount initializedAt createdAt updatedAt')
    .select('+adminCount')
    .lean();
  let reconciled = 0;

  for (const tenant of tenants) {
    const tenantId = String(tenant._id);
    const actualCount = countByTenant.get(tenantId) || { userCount: 0, adminCount: 0 };
    const { userCount, adminCount } = actualCount;
    const needsInitializedAt = userCount > 0 && !tenant.initializedAt;
    if (userCount === tenant.userCount && adminCount === tenant.adminCount && !needsInitializedAt) {
      continue;
    }

    const filter = { _id: tenant._id, status: { $ne: 'deleting' } };
    if (typeof tenant.userCount === 'number') {
      filter.userCount = tenant.userCount;
    } else {
      filter.userCount = { $exists: false };
    }
    if (tenant.updatedAt) {
      filter.updatedAt = tenant.updatedAt;
    }

    const result = await Tenant.updateOne(filter, {
      $set: {
        userCount,
        adminCount,
        ...(userCount === 0
          ? { initializedAt: null }
          : needsInitializedAt
            ? { initializedAt: tenant.createdAt || new Date() }
            : {}),
      },
    });
    if (result.modifiedCount === 1) {
      reconciled += 1;
    }
  }

  return reconciled;
};

const ensureTenantCounterSynced = async (tenantId, session) => {
  const rawTenant = await Tenant.collection.findOne(
    { _id: new mongoose.Types.ObjectId(tenantId) },
    session ? { session } : {}
  );
  if (!rawTenant || rawTenant.status === 'deleting') {
    return null;
  }

  if (typeof rawTenant.userCount !== 'number' || typeof rawTenant.adminCount !== 'number') {
    const actualCountQuery = User.countDocuments({ tenantId: String(tenantId) });
    const actualAdminCountQuery = User.countDocuments({ tenantId: String(tenantId), role: 'admin' });
    if (session) {
      actualCountQuery.session(session);
      actualAdminCountQuery.session(session);
    }
    const [actualCount, actualAdminCount] = await Promise.all([
      actualCountQuery,
      actualAdminCountQuery,
    ]);
    await Tenant.updateOne(
      { _id: rawTenant._id },
      {
        $set: {
          status: rawTenant.status || 'active',
          userCount: actualCount,
          adminCount: actualAdminCount,
          initializedAt: actualCount > 0 ? rawTenant.createdAt || new Date() : null,
        },
      },
      session ? { session } : {}
    );
  }

  const tenantQuery = Tenant.findOne({ _id: tenantId, status: { $ne: 'deleting' } });
  if (session) {
    tenantQuery.session(session);
  }
  return tenantQuery;
};

exports.createTenant = async ({ name, plan = 'freemium' }) => {
  if (typeof name !== 'string' || name.trim().length < 2 || name.trim().length > 120) {
    throw createOperationalError('O nome do tenant deve ter entre 2 e 120 caracteres.', 400);
  }

  const normalizedName = name.trim();
  const planDoc = await getPlanByName(plan);
  if (planDoc.price > 0) {
    throw createOperationalError('O plano selecionado requer ativação de pagamento.', 403);
  }

  const registrationToken = crypto.randomBytes(32).toString('hex');
  const registrationTokenHash = crypto.createHash('sha256').update(registrationToken).digest('hex');

  const existingTenant = await Tenant.findOne({ name: normalizedName })
    .select('+registrationTokenHash +registrationTokenExpiresAt')
    .collation(TENANT_NAME_COLLATION);

  if (existingTenant) {
    const now = new Date();
    const isExpiredOrLegacyUninitialized =
      existingTenant.status !== 'deleting' &&
      existingTenant.userCount === 0 &&
      existingTenant.initializedAt === null &&
      (!existingTenant.registrationTokenHash ||
        !existingTenant.registrationTokenExpiresAt ||
        existingTenant.registrationTokenExpiresAt <= now);

    let reclaimed = false;
    if (isExpiredOrLegacyUninitialized) {
      const hasUsers = await User.exists({ tenantId: String(existingTenant._id) });
      if (!hasUsers) {
        const delRes = await Tenant.deleteOne({
          _id: existingTenant._id,
          status: { $ne: 'deleting' },
          ...buildExpiredUninitializedCondition(now),
        });
        reclaimed = delRes.deletedCount === 1;
      }
    }

    if (!reclaimed) {
      throw createOperationalError('Não foi possível criar o tenant com os dados informados.', 409);
    }
  }

  try {
    const tenant = await Tenant.create({
      name: normalizedName,
      plan: planDoc.name,
      status: 'active',
      adminCount: 0,
      userCount: 0,
      initializedAt: null,
      registrationTokenHash,
      registrationTokenExpiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
    });

    return { tenant, registrationToken };
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
  let targetPlan = null;

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
    targetPlan = await getPlanByName(plan);

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

      const filter = {
        _id: tenant._id,
        status: { $ne: 'deleting' },
        plan: tenant.plan,
        ...(targetPlan.maxUsers !== null ? { userCount: { $lte: targetPlan.maxUsers } } : {}),
      };
      const update = { $set: { plan: targetPlan.name } };
      if (name !== undefined) {
        update.$set.name = tenant.name;
      }

      try {
        const updatedTenant = await Tenant.findOneAndUpdate(filter, update, {
          returnDocument: 'after',
          runValidators: true,
        });
        if (!updatedTenant) {
          throw createOperationalError(
            'O tenant foi alterado por outra operação. Recarregue os dados e tente novamente.',
            409
          );
        }
        return updatedTenant;
      } catch (error) {
        if (error.code === 11000) {
          throw createOperationalError('Já existe um tenant com este nome.', 409);
        }
        throw error;
      }
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
    schedulePendingTenantReconciliation();
    throw cleanupError;
  }
};

exports.reserveUserSlot = async (
  tenantId,
  { initialPublicRegister = false, registrationToken, session } = {}
) => {
  if (!mongoose.isValidObjectId(String(tenantId))) {
    throw createOperationalError('O tenantId informado é inválido.', 400);
  }

  const tenant = await ensureTenantCounterSynced(tenantId, session);
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
  const isFirstSlot = tenant.userCount === 0 && tenant.initializedAt === null;
  const requiresRegistrationToken = initialPublicRegister && isFirstSlot;
  const tokenHash =
    requiresRegistrationToken &&
    typeof registrationToken === 'string' &&
    /^[a-f\d]{64}$/i.test(registrationToken)
      ? crypto.createHash('sha256').update(registrationToken).digest('hex')
      : null;

  if (requiresRegistrationToken && !tokenHash) {
    throw createOperationalError(
      'Não foi possível concluir o registro com os dados informados.',
      403
    );
  }

  if (initialPublicRegister && !allowPublicMultiRegister) {
    if (!isFirstSlot) {
      throw createOperationalError(
        'Não foi possível concluir o registro com os dados informados.',
        403
      );
    }

    if (maxUsers !== null && maxUsers < 1) {
      throw createOperationalError('Limite de usuários atingido para este plano.', 403);
    }

    const reserved = await Tenant.findOneAndUpdate(
      {
        _id: tenant._id,
        status: { $ne: 'deleting' },
        userCount: 0,
        initializedAt: null,
        registrationTokenHash: tokenHash,
        registrationTokenExpiresAt: { $gt: new Date() },
      },
      { $inc: { userCount: 1 }, $set: { initializedAt: new Date() } },
      { returnDocument: 'after', ...(session ? { session } : {}) }
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
    ...(requiresRegistrationToken
      ? {
          userCount: 0,
          initializedAt: null,
          registrationTokenHash: tokenHash,
          registrationTokenExpiresAt: { $gt: new Date() },
        }
      : {}),
  };

  const shouldMarkInitialized = isFirstSlot;
  const update = {
    $inc: { userCount: 1 },
    ...(shouldMarkInitialized ? { $set: { initializedAt: new Date() } } : {}),
  };

  const reserved = await Tenant.findOneAndUpdate(filter, update, {
    returnDocument: 'after',
    ...(session ? { session } : {}),
  });
  if (!reserved) {
    if (requiresRegistrationToken) {
      throw createOperationalError(
        'Não foi possível concluir o registro com os dados informados.',
        403
      );
    }
    const stillExistsQuery = Tenant.exists({ _id: tenant._id, status: { $ne: 'deleting' } });
    if (session) {
      stillExistsQuery.session(session);
    }
    const stillExists = await stillExistsQuery;
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

exports.releaseUserSlot = async (tenantId, { wasInitialSlot = false, session } = {}) => {
  if (wasInitialSlot) {
    const resetResult = await Tenant.updateOne(
      { _id: tenantId, userCount: 1 },
      { $set: { userCount: 0, initializedAt: null } },
      session ? { session } : {}
    );
    if (resetResult.matchedCount > 0) {
      return;
    }
  }

  await Tenant.updateOne(
    { _id: tenantId, userCount: { $gt: 0 } },
    { $inc: { userCount: -1 } },
    session ? { session } : {}
  );
};

exports.reconcilePendingTenantDeletions = reconcilePendingTenantDeletions;
exports.syncLegacyTenantsAndUsers = syncLegacyTenantsAndUsers;
exports.supportsTransactions = supportsTransactions;
exports.isTransactionUnsupportedError = isTransactionUnsupportedError;
