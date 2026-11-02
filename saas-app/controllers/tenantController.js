const {
  createTenant,
  getTenantById,
  getTenantUsers,
  listTenantsByUser,
  updateTenant,
  deleteTenant,
} = require('../services/tenantService');

exports.listTenants = async (req, res, next) => {
  try {
    const tenants = await listTenantsByUser(req.user.tenantId);
    return res.json(tenants);
  } catch (error) {
    return next(error);
  }
};

exports.createTenant = async (req, res, next) => {
  try {
    const { tenant, registrationToken } = await createTenant(req.body);
    return res.status(201).json({ ...tenant.toJSON(), registrationToken });
  } catch (error) {
    return next(error);
  }
};

exports.getTenant = async (req, res, next) => {
  try {
    const tenant = await getTenantById(req.params.id);
    return res.json(tenant);
  } catch (error) {
    return next(error);
  }
};

exports.updateTenant = async (req, res, next) => {
  try {
    const tenant = await updateTenant(req.params.id, req.body);
    return res.json(tenant);
  } catch (error) {
    return next(error);
  }
};

exports.deleteTenant = async (req, res, next) => {
  try {
    const result = await deleteTenant(req.params.id);
    return res.json({ message: 'Tenant removido com sucesso.', ...result });
  } catch (error) {
    return next(error);
  }
};

exports.getTenantUsers = async (req, res, next) => {
  try {
    const result = await getTenantUsers(req.params.id, {
      page: req.query.page,
      limit: req.query.limit,
    });
    res.setHeader('X-Total-Count', String(result.total));
    return res.json(result.users);
  } catch (error) {
    return next(error);
  }
};
