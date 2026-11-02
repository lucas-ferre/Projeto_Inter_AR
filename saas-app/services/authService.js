const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const mongoose = require('mongoose');
const Tenant = require('../models/Tenant');
const User = require('../models/User');
const { createOperationalError } = require('./errors');
const userService = require('./userService');

const {
  BCRYPT_ROUNDS,
  runWithOptionalTransaction,
  createUserWithReservedSlot,
} = userService;

const DUMMY_PASSWORD_HASH = bcrypt.hashSync('dummy_timing_protection_secret_key', BCRYPT_ROUNDS);

const loginUser = async ({ email, password, tenantId }) => {
  const normalizedEmail = email.trim().toLowerCase();
  const filter = { email: normalizedEmail };

  if (tenantId !== undefined) {
    const normalizedTenantId = String(tenantId).trim();
    if (!mongoose.isValidObjectId(normalizedTenantId)) {
      throw createOperationalError('O tenantId informado é inválido.', 400);
    }
    filter.tenantId = normalizedTenantId;
  }

  const candidates = await User.find(filter).select('+password').sort({ createdAt: 1 });
  if (candidates.length === 0) {
    await bcrypt.compare(password, DUMMY_PASSWORD_HASH);
    throw createOperationalError('Credenciais inválidas.', 401);
  }

  const validTenantIds = candidates
    .map((u) => u.tenantId)
    .filter((id) => mongoose.isValidObjectId(id));

  const activeTenants =
    validTenantIds.length > 0
      ? await Tenant.find({
          _id: { $in: validTenantIds },
          status: { $ne: 'deleting' },
        })
          .select('_id')
          .lean()
      : [];

  const activeTenantSet = new Set(activeTenants.map((t) => String(t._id)));
  const activeCandidates = candidates.filter((u) => activeTenantSet.has(String(u.tenantId)));

  if (activeCandidates.length === 0) {
    await bcrypt.compare(password, DUMMY_PASSWORD_HASH);
    throw createOperationalError('Credenciais inválidas.', 401);
  }

  const comparisons = await Promise.all(
    activeCandidates.map(async (candidate) => {
      const ok = await bcrypt.compare(password, candidate.password);
      return ok ? candidate : null;
    })
  );

  const matchedUsers = comparisons.filter(Boolean);
  if (matchedUsers.length === 0) {
    throw createOperationalError('Credenciais inválidas.', 401);
  }

  if (matchedUsers.length > 1) {
    throw createOperationalError(
      'Este e-mail possui contas em múltiplos tenants. Informe o campo tenantId no login.',
      409
    );
  }

  const user = matchedUsers[0];
  const role = user.role || 'member';
  const token = jwt.sign(
    { userId: String(user._id), tenantId: String(user.tenantId), role },
    process.env.JWT_SECRET,
    { algorithm: 'HS256', expiresIn: '1h' }
  );

  return {
    token,
    user: user.toJSON(),
  };
};

const registerUser = async ({ name, email, password, tenantId, registrationToken }) => {
  const normalizedTenantId = String(tenantId).trim();
  const normalizedEmail = email.trim().toLowerCase();

  if (!mongoose.isValidObjectId(normalizedTenantId)) {
    throw createOperationalError('O tenantId informado é inválido.', 400);
  }

  if (
    process.env.ALLOW_PUBLIC_MULTI_REGISTER !== 'true' &&
    (typeof registrationToken !== 'string' || !/^[a-f\d]{64}$/i.test(registrationToken))
  ) {
    throw createOperationalError(
      'Não foi possível concluir o registro com os dados informados.',
      403
    );
  }

  const existingUser = await User.exists({
    tenantId: normalizedTenantId,
    email: normalizedEmail,
  });
  if (existingUser) {
    throw createOperationalError(
      'Não foi possível concluir o registro com os dados informados.',
      400
    );
  }

  const hashedPassword = await bcrypt.hash(password, BCRYPT_ROUNDS);
  try {
    return await runWithOptionalTransaction((session) =>
      createUserWithReservedSlot({
        tenantId: normalizedTenantId,
        name: name.trim(),
        email: normalizedEmail,
        password: hashedPassword,
        initialPublicRegister: true,
        registrationToken,
        session,
      })
    );
  } catch (error) {
    if (error.code === 11000) {
      throw createOperationalError(
        'Não foi possível concluir o registro com os dados informados.',
        400
      );
    }
    throw error;
  }
};

module.exports = {
  loginUser,
  registerUser,
  ...userService,
};
