const express = require('express');
const verifyToken = require('../middleware/verifyToken');
const requireAdmin = require('../middleware/requireAdmin');
const ensureSameTenant = require('../middleware/ensureSameTenant');
const { validateTenant, validateTenantUpdate } = require('../middleware/validateRequest');
const { createRateLimiter } = require('../middleware/rateLimiter');
const {
  listTenants,
  createTenant,
  getTenant,
  updateTenant,
  deleteTenant,
  getTenantUsers,
} = require('../controllers/tenantController');

const router = express.Router();
const tenantCreationLimiter = createRateLimiter({
  scope: 'tenant-create',
  windowMs: 60 * 1000,
  maxRequests: 15,
});

router.get('/', verifyToken, listTenants);
router.post('/', tenantCreationLimiter, validateTenant, createTenant);
router.get('/:id', verifyToken, ensureSameTenant, getTenant);
router.put('/:id', verifyToken, ensureSameTenant, requireAdmin, validateTenantUpdate, updateTenant);
router.patch('/:id', verifyToken, ensureSameTenant, requireAdmin, validateTenantUpdate, updateTenant);
router.delete('/:id', verifyToken, ensureSameTenant, requireAdmin, deleteTenant);
router.get('/:id/users', verifyToken, ensureSameTenant, getTenantUsers);

module.exports = router;
