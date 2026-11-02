const {
  createUserInTenant,
  listUsersByTenant,
  getUserByTenant,
  updateUserInTenant,
  deleteUserFromTenant,
} = require('../services/userService');

exports.listUsers = async (req, res, next) => {
  try {
    const result = await listUsersByTenant(req.user.tenantId, {
      page: req.query.page,
      limit: req.query.limit,
    });
    res.setHeader('X-Total-Count', String(result.total));
    return res.json(result.users);
  } catch (error) {
    return next(error);
  }
};

exports.addUser = async (req, res, next) => {
  try {
    const { name, email, password, role } = req.body;
    const tenantId = req.user.tenantId;

    const user = await createUserInTenant({ name, email, password, role, tenantId });
    return res.status(201).json(user);
  } catch (error) {
    return next(error);
  }
};

exports.getUser = async (req, res, next) => {
  try {
    const user = await getUserByTenant(req.user.tenantId, req.params.id);
    return res.json(user);
  } catch (error) {
    return next(error);
  }
};

exports.updateUser = async (req, res, next) => {
  try {
    const user = await updateUserInTenant({
      tenantId: req.user.tenantId,
      targetUserId: req.params.id,
      requester: req.user,
      payload: req.body,
    });
    return res.json(user);
  } catch (error) {
    return next(error);
  }
};

exports.removeUser = async (req, res, next) => {
  try {
    const result = await deleteUserFromTenant(
      req.user.tenantId,
      req.params.id,
      req.user.userId
    );
    return res.json({ message: 'Usuário removido com sucesso.', ...result });
  } catch (error) {
    return next(error);
  }
};
