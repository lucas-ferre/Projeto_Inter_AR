const bcrypt = require('bcryptjs');
const mongoose = require('mongoose');
const Tenant = require('../models/Tenant');
const User = require('../models/User');
const { createOperationalError } = require('./errors');
const {
  reserveUserSlot,
  releaseUserSlot,
  getTenantUsers,
  supportsTransactions,
  isTransactionUnsupportedError,
} = require('./tenantService');

const BCRYPT_ROUNDS = 10;

const runWithOptionalTransaction = async (operation) => {
  if (!supportsTransactions()) {
    return operation(null);
  }

  const session = await mongoose.startSession();
  try {
    let result;
    await session.withTransaction(async () => {
      result = await operation(session);
    });
    return result;
  } catch (error) {
    if (!isTransactionUnsupportedError(error)) {
      throw error;
    }
  } finally {
    await session.endSession();
  }

  return operation(null);
};

const incrementAdminCount = async (
  tenantId,
  session,
  { clearRegistrationToken = false } = {}
) => {
  const update = {
    $inc: { adminCount: 1 },
    ...(clearRegistrationToken
      ? { $unset: { registrationTokenHash: 1, registrationTokenExpiresAt: 1 } }
      : {}),
  };
  const result = await Tenant.updateOne(
    { _id: tenantId, status: { $ne: 'deleting' } },
    update,
    session ? { session } : {}
  );
  if (result.matchedCount !== 1) {
    throw createOperationalError('Tenant não encontrado.', 404);
  }
};

const reserveAdminRemoval = async (tenantId, session) => {
  const result = await Tenant.updateOne(
    { _id: tenantId, status: { $ne: 'deleting' }, adminCount: { $gt: 1 } },
    { $inc: { adminCount: -1 } },
    session ? { session } : {}
  );
  if (result.matchedCount !== 1) {
    throw createOperationalError('Não é possível remover o único administrador do tenant.', 400);
  }
};

const createUserWithReservedSlot = async ({
  tenantId,
  name,
  email,
  password,
  role,
  initialPublicRegister = false,
  registrationToken,
  session,
}) => {
  const slot = await reserveUserSlot(tenantId, {
    initialPublicRegister,
    registrationToken,
    session,
  });
  const assignedRole = initialPublicRegister
    ? slot.assignedRole
    : slot.tenant.userCount === 1
      ? 'admin'
      : role;
  let user;
  let adminCountIncremented = false;

  try {
    const userData = { name, email, password, role: assignedRole, tenantId };
    user = session
      ? (await User.create([userData], { session }))[0]
      : await User.create(userData);

    if (user.role === 'admin') {
      await incrementAdminCount(tenantId, session, {
        clearRegistrationToken: Boolean(slot.wasInitialSlot),
      });
      adminCountIncremented = true;
    }

    return user.toJSON();
  } catch (error) {
    if (!session) {
      if (user) {
        await User.deleteOne({ _id: user._id });
      }
      if (adminCountIncremented) {
        await Tenant.updateOne({ _id: tenantId }, { $inc: { adminCount: -1 } });
      }
      await releaseUserSlot(tenantId, { wasInitialSlot: slot.wasInitialSlot });
    }
    throw error;
  }
};

const createUserInTenant = async ({ name, email, password, tenantId, role = 'member' }) => {
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
  try {
    return await runWithOptionalTransaction((session) =>
      createUserWithReservedSlot({
        tenantId: normalizedTenantId,
        name: name.trim(),
        email: normalizedEmail,
        password: hashedPassword,
        role: normalizedRole,
        session,
      })
    );
  } catch (error) {
    if (error.code === 11000) {
      throw createOperationalError('Este e-mail já está cadastrado neste tenant.', 409);
    }
    throw error;
  }
};

const listUsersByTenant = async (tenantId, pagination = {}) => {
  return getTenantUsers(tenantId, pagination);
};

const getUserByTenant = async (tenantId, userId) => {
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

const updateUserInTenant = async ({ tenantId, targetUserId, requester, payload }) => {
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
  const hashedPassword = password !== undefined ? await bcrypt.hash(password, BCRYPT_ROUNDS) : null;

  try {
    return await runWithOptionalTransaction(async (session) => {
      const tenantExistsQuery = Tenant.exists({ _id: tenantId, status: { $ne: 'deleting' } });
      if (session) {
        tenantExistsQuery.session(session);
      }
      if (!(await tenantExistsQuery)) {
        throw createOperationalError('Tenant não encontrado.', 404);
      }

      const userQuery = User.findOne({ _id: targetUserId, tenantId: String(tenantId) });
      if (session) {
        userQuery.session(session);
      }
      const user = await userQuery;
      if (!user) {
        throw createOperationalError('Usuário não encontrado neste tenant.', 404);
      }

      const originalRole = user.role || 'member';
      const updateFields = {};

      if (role !== undefined && role !== originalRole) {
        updateFields.role = role;
      }

      if (name !== undefined) {
        updateFields.name = name.trim();
      }

      if (email !== undefined) {
        const normalizedEmail = email.trim().toLowerCase();
        if (normalizedEmail !== user.email) {
          const emailTakenQuery = User.exists({
            tenantId: String(tenantId),
            email: normalizedEmail,
            _id: { $ne: user._id },
          });
          if (session) {
            emailTakenQuery.session(session);
          }
          if (await emailTakenQuery) {
            throw createOperationalError('Este e-mail já está cadastrado neste tenant.', 409);
          }
          updateFields.email = normalizedEmail;
        }
      }

      if (hashedPassword) {
        updateFields.password = hashedPassword;
      }

      if (Object.keys(updateFields).length === 0) {
        return user.toJSON();
      }

      const demotingAdmin = originalRole === 'admin' && role === 'member';
      const promotingMember = originalRole === 'member' && role === 'admin';
      const updateFilter = {
        _id: user._id,
        tenantId: String(tenantId),
        ...(demotingAdmin
          ? { role: 'admin' }
          : promotingMember
            ? { role: { $ne: 'admin' } }
            : {}),
      };
      let adminRemovalReserved = false;
      let userSaved = false;

      try {
        if (demotingAdmin) {
          await reserveAdminRemoval(tenantId, session);
          adminRemovalReserved = true;
        }
        const updatedUser = await User.findOneAndUpdate(
          updateFilter,
          { $set: updateFields },
          {
            returnDocument: 'after',
            runValidators: true,
            ...(session ? { session } : {}),
          }
        );
        if (!updatedUser) {
          throw createOperationalError(
            'O usuário foi alterado por outra operação. Tente novamente.',
            409
          );
        }
        userSaved = true;
        if (promotingMember) {
          await incrementAdminCount(tenantId, session);
        }
        return updatedUser.toJSON();
      } catch (error) {
        if (!session && adminRemovalReserved) {
          await incrementAdminCount(tenantId);
        }
        if (!session && promotingMember && userSaved) {
          await User.updateOne(
            { _id: user._id, tenantId: String(tenantId), role: 'admin' },
            { $set: { role: 'member' } }
          );
        }
        throw error;
      }
    });
  } catch (error) {
    if (error.code === 11000) {
      throw createOperationalError('Este e-mail já está cadastrado neste tenant.', 409);
    }
    throw error;
  }
};

const deleteUserFromTenant = async (tenantId, userId, requesterUserId) => {
  if (!mongoose.isValidObjectId(String(tenantId)) || !mongoose.isValidObjectId(String(userId))) {
    throw createOperationalError('ID inválido.', 400);
  }

  if (requesterUserId && String(userId) === String(requesterUserId)) {
    throw createOperationalError('Você não pode remover a sua própria conta.', 400);
  }

  return runWithOptionalTransaction(async (session) => {
    const tenantExistsQuery = Tenant.exists({ _id: tenantId, status: { $ne: 'deleting' } });
    if (session) {
      tenantExistsQuery.session(session);
    }
    if (!(await tenantExistsQuery)) {
      throw createOperationalError('Tenant não encontrado.', 404);
    }

    const targetUserQuery = User.findOne({ _id: userId, tenantId: String(tenantId) });
    if (session) {
      targetUserQuery.session(session);
    }
    const targetUser = await targetUserQuery;
    if (!targetUser) {
      throw createOperationalError('Usuário não encontrado neste tenant.', 404);
    }

    const wasAdmin = targetUser.role === 'admin';
    if (wasAdmin) {
      await reserveAdminRemoval(tenantId, session);
    }

    let deleted;
    try {
      deleted = await User.findOneAndDelete(
        {
          _id: userId,
          tenantId: String(tenantId),
          role: wasAdmin ? 'admin' : { $ne: 'admin' },
        },
        session ? { session } : {}
      );
    } catch (error) {
      if (!session && wasAdmin) {
        await incrementAdminCount(tenantId);
      }
      throw error;
    }

    if (!deleted) {
      if (!session && wasAdmin) {
        await incrementAdminCount(tenantId);
      }
      const stillExistsQuery = User.exists({ _id: userId, tenantId: String(tenantId) });
      if (session) {
        stillExistsQuery.session(session);
      }
      if (await stillExistsQuery) {
        throw createOperationalError(
          'O papel do usuário foi alterado durante a operação. Tente novamente.',
          409
        );
      }
      throw createOperationalError('Usuário não encontrado neste tenant.', 404);
    }

    await Tenant.updateOne(
      { _id: tenantId, userCount: { $gt: 0 } },
      { $inc: { userCount: -1 } },
      session ? { session } : {}
    );

    return { deletedUserId: deleted._id, deleted: true };
  });
};

module.exports = {
  BCRYPT_ROUNDS,
  runWithOptionalTransaction,
  incrementAdminCount,
  reserveAdminRemoval,
  createUserWithReservedSlot,
  createUserInTenant,
  listUsersByTenant,
  getUserByTenant,
  updateUserInTenant,
  deleteUserFromTenant,
};
