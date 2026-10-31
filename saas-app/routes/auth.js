const express = require('express');
const { login, register } = require('../controllers/authController');
const { validateLogin, validateRegister } = require('../middleware/validateRequest');
const { createRateLimiter } = require('../middleware/rateLimiter');
const router = express.Router();

const authLimiter = createRateLimiter({
  scope: 'auth',
  windowMs: 60 * 1000,
  maxRequests: 25,
  failClosed: true,
});

router.post('/login', authLimiter, validateLogin, login);
router.post('/register', authLimiter, validateRegister, register);

module.exports = router;
