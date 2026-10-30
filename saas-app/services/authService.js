const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const mongoose = require('mongoose');
const Tenant = require('../models/Tenant');
const User = require('../models/User');
const { createOperationalError } = require('./errors');
const {
  reserveUserSlot,
  releaseUserSlot,
  getTenantUsers,
} = require('./tenantService');

const BCRYPT_ROUNDS = 10;
const DUMMY_PASSWORD_HASH = bcrypt.hashSync('dummy_timing_protection_secret_key', BCRYPT_ROUNDS);

exports.loginUser = async ({ email, password, tenantId }) => {
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

exports.registerUser = async ({ name, email, password, tenantId }) => {
  const normalizedTenantId = String(tenantId).trim();
  const normalizedEmail = email.trim().toLowerCase();

  if (!mongoose.isValidObjectId(normalizedTenantId)) {
    throw createOperationalError('O tenantId informado é inválido.', 400);
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
  const slot = await reserveUserSlot(normalizedTenantId, { initialPublicRegister: true });

  try {
    const user = await User.create({
      name: name.trim(),
      email: normalizedEmail,
      password: hashedPassword,
      role: slot.assignedRole,
      tenantId: normalizedTenantId,
    });

    return user.toJSON();
  } catch (error) {
    await releaseUserSlot(normalizedTenantId, { wasInitialSlot: slot.wasInitialSlot });
    if (error.code === 11000) {
      throw createOperationalError(
        'Não foi possível concluir o registro com os dados informados.',
        400
      );
    }
    throw error;
  }
};

exports.createUserInTenant = async ({ name, email, password, tenantId, role = 'member' }) => {
  const normalizedTenantId = String(tenantId).trim();
  const normalizedEmail = email.trim().toLowerCase();
  const normalizedRole = role || 'member';

  if (!['admin', 'member'].includes(normalizedRole)) {
    throw createOperationalError('O papel (role) deve ser admin ou member.', 400);
  }

  const existingUser = await User.exists({
    tenantId: normalizedTenantId,
    email: normalizedEmail,
  });
  if (existingUser) {
    throw createOperationalError('Este e-mail já está cadastrado neste tenant.', 409);
  }

  const hashedPassword = await bcrypt.hash(password, BCRYPT_ROUNDS);
  const slot = await reserveUserSlot(normalizedTenantId, { initialPublicRegister: false });

  try {
    const user = await User.create({
      name: name.trim(),
      email: normalizedEmail,
      password: hashedPassword,
      role: slot.tenant.userCount === 1 ? 'admin' : normalizedRole,
      tenantId: normalizedTenantId,
    });

    return user.toJSON();
  } catch (error) {
    await releaseUserSlot(normalizedTenantId, { wasInitialSlot: slot.wasInitialSlot });
    if (error.code === 11000) {
      throw createOperationalError('Este e-mail já está cadastrado neste tenant.', 409);
    }
    throw error;
  }
};

exports.listUsersByTenant = async (tenantId, pagination = {}) => {
  return getTenantUsers(tenantId, pagination);
};

exports.getUserByTenant = async (tenantId, userId) => {
  if (!mongoose.isValidObjectId(String(tenantId)) || !mongoose.isValidObjectId(String(userId))) {
    throw createOperationalError('ID inválido.', 400);
  }

  const tenantExists = await Tenant.exists({ _id: tenantId, status: { $ne: 'deleting' } });
  if (!tenantExists) {
    throw createOperationalError('Tenant não encontrado.', 404);
  }

  const user = await User.findOne({ _id: userId, tenantId: String(tenantId) });
  if (!user) {
    throw createOperationalError('Usuário não encontrado neste tenant.', 404);
  }

  return user.toJSON();
};

exports.updateUserInTenant = async ({ tenantId, targetUserId, requester, payload }) => {
  if (
    !mongoose.isValidObjectId(String(tenantId)) ||
    !mongoose.isValidObjectId(String(targetUserId))
  ) {
    throw createOperationalError('ID inválido.', 400);
  }

  const isAdmin = requester?.role === 'admin';
  const isSelf = String(requester?.userId) === String(targetUserId);

  if (!isAdmin && !isSelf) {
    throw createOperationalError('Acesso restrito a administradores do tenant.', 403);
  }

  const { name, email, password, role } = payload || {};

  if (!isAdmin && role !== undefined) {
    throw createOperationalError('Apenas administradores podem alterar papéis de usuário.', 403);
  }

  const tenantExists = await Tenant.exists({ _id: tenantId, status: { $ne: 'deleting' } });
  if (!tenantExists) {
    throw createOperationalError('Tenant não encontrado.', 404);
  }

  const user = await User.findOne({ _id: targetUserId, tenantId: String(tenantId) });
  if (!user) {
    throw createOperationalError('Usuário não encontrado neste tenant.', 404);
  }

  if (role !== undefined && role !== user.role) {
    if (user.role === 'admin' && role === 'member') {
      const adminCount = await User.countDocuments({ tenantId: String(tenantId), role: 'admin' });
      if (adminCount <= 1) {
        throw createOperationalError(
          'Não é possível remover o privilégio do único administrador do tenant.',
          400
        );
      }
    }
    user.role = role;
  }

  if (name !== undefined) {
    user.name = name.trim();
  }

  if (email !== undefined) {
    const normalizedEmail = email.trim().toLowerCase();
    if (normalizedEmail !== user.email) {
      const emailTaken = await User.exists({
        tenantId: String(tenantId),
        email: normalizedEmail,
        _id: { $ne: user._id },
      });
      if (emailTaken) {
        throw createOperationalError('Este e-mail já está cadastrado neste tenant.', 409);
      }
      user.email = normalizedEmail;
    }
  }

  if (password !== undefined) {
    user.password = await bcrypt.hash(password, BCRYPT_ROUNDS);
  }

  try {
    await user.save();
    return user.toJSON();
  } catch (error) {
    if (error.code === 11000) {
      throw createOperationalError('Este e-mail já está cadastrado neste tenant.', 409);
    }
    throw error;
  }
};

exports.deleteUserFromTenant = async (tenantId, userId, requesterUserId) => {
  if (!mongoose.isValidObjectId(String(tenantId)) || !mongoose.isValidObjectId(String(userId))) {
    throw createOperationalError('ID inválido.', 400);
  }

  if (requesterUserId && String(userId) === String(requesterUserId)) {
    throw createOperationalError('Você não pode remover a sua própria conta.', 400);
  }

  const tenantExists = await Tenant.exists({ _id: tenantId, status: { $ne: 'deleting' } });
  if (!tenantExists) {
    throw createOperationalError('Tenant não encontrado.', 404);
  }

  const targetUser = await User.findOne({ _id: userId, tenantId: String(tenantId) });
  if (!targetUser) {
    throw createOperationalError('Usuário não encontrado neste tenant.', 404);
  }

  if (targetUser.role === 'admin') {
    const adminCount = await User.countDocuments({ tenantId: String(tenantId), role: 'admin' });
    if (adminCount <= 1) {
      throw createOperationalError('Não é possível remover o único administrador do tenant.', 400);
    }
  }

  const deleted = await User.findOneAndDelete({ _id: userId, tenantId: String(tenantId) });
  if (!deleted) {
    throw createOperationalError('Usuário não encontrado neste tenant.', 404);
  }

  await Tenant.updateOne({ _id: tenantId, userCount: { $gt: 0 } }, { $inc: { userCount: -1 } });

  return { deletedUserId: deleted._id, deleted: true };
};
