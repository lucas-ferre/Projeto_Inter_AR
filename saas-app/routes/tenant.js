const express = require('express');
const mongoose = require('mongoose');
const verifyToken = require('../middleware/verifyToken');
const requireAdmin = require('../middleware/requireAdmin');
const { validateTenant, validateTenantUpdate } = require('../middleware/validateRequest');
const { createRateLimiter } = require('../middleware/rateLimiter');
const {
  createTenant,
  getTenantById,
  getTenantUsers,
  listTenantsByUser,
  updateTenant,
  deleteTenant,
} = require('../services/tenantService');

const router = express.Router();
const tenantCreationLimiter = createRateLimiter({
  scope: 'tenant-create',
  windowMs: 60 * 1000,
  maxRequests: 15,
});

const ensureSameTenant = (req, res, next) => {
  const { id } = req.params;

  if (!mongoose.isValidObjectId(id)) {
    return res.status(400).json({ message: 'ID do tenant inválido.' });
  }

  if (String(req.user.tenantId) !== String(id)) {
    return res.status(403).json({ message: 'Acesso negado aos dados de outro tenant.' });
  }

  return next();
};

const handleTenantUpdate = async (req, res, next) => {
  try {
    const tenant = await updateTenant(req.params.id, req.body);
    return res.json(tenant);
  } catch (error) {
    return next(error);
  }
};

router.get('/', verifyToken, async (req, res, next) => {
  try {
    const tenants = await listTenantsByUser(req.user.tenantId);
    return res.json(tenants);
  } catch (error) {
    return next(error);
  }
});

router.post('/', tenantCreationLimiter, validateTenant, async (req, res, next) => {
  try {
    const tenant = await createTenant(req.body);
    return res.status(201).json(tenant);
  } catch (error) {
    return next(error);
  }
});

router.get('/:id', verifyToken, ensureSameTenant, async (req, res, next) => {
  try {
    const tenant = await getTenantById(req.params.id);
    return res.json(tenant);
  } catch (error) {
    return next(error);
  }
});

router.put(
  '/:id',
  verifyToken,
  ensureSameTenant,
  requireAdmin,
  validateTenantUpdate,
  handleTenantUpdate
);

router.patch(
  '/:id',
  verifyToken,
  ensureSameTenant,
  requireAdmin,
  validateTenantUpdate,
  handleTenantUpdate
);

router.delete('/:id', verifyToken, ensureSameTenant, requireAdmin, async (req, res, next) => {
  try {
    const result = await deleteTenant(req.params.id);
    return res.json({ message: 'Tenant removido com sucesso.', ...result });
  } catch (error) {
    return next(error);
  }
});

router.get('/:id/users', verifyToken, ensureSameTenant, async (req, res, next) => {
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
});

module.exports = router;
