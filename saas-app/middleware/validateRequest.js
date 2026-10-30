const mongoose = require('mongoose');

const MAX_EMAIL_LENGTH = 254;
const MIN_NAME_LENGTH = 2;
const MAX_NAME_LENGTH = 120;
const MIN_PASSWORD_LENGTH = 6;
const MAX_PASSWORD_BYTES = 72;
const MAX_PLAN_NAME_LENGTH = 40;

// Regex determinística (O(N), sem backtracking quadrático) compatível com domínios DNS e RFC 5321
const emailRegex =
  /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/;

const isPlainObject = (value) =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isValidEmail = (email) => {
  if (typeof email !== 'string') return false;
  const trimmed = email.trim();
  if (trimmed.length < 5 || trimmed.length > MAX_EMAIL_LENGTH) return false;
  return emailRegex.test(trimmed);
};

const isValidName = (value) => {
  if (typeof value !== 'string') return false;
  const trimmed = value.trim();
  return trimmed.length >= MIN_NAME_LENGTH && trimmed.length <= MAX_NAME_LENGTH;
};

const validatePasswordRules = (password) => {
  if (typeof password !== 'string' || password.trim().length < MIN_PASSWORD_LENGTH) {
    return 'A senha deve ter pelo menos 6 caracteres válidos.';
  }

  if (Buffer.byteLength(password, 'utf8') > MAX_PASSWORD_BYTES) {
    return 'A senha deve ter no máximo 72 bytes.';
  }

  return null;
};

const isValidPlanFormat = (plan) =>
  typeof plan === 'string' &&
  plan.trim().length >= 2 &&
  plan.trim().length <= MAX_PLAN_NAME_LENGTH;

const validateLogin = (req, res, next) => {
  if (!isPlainObject(req.body)) {
    return res.status(400).json({ message: 'Corpo da requisição inválido.' });
  }

  const { email, password, tenantId } = req.body;

  if (!isValidEmail(email)) {
    return res.status(400).json({ message: 'Informe um e-mail válido.' });
  }

  if (
    typeof password !== 'string' ||
    password.length < MIN_PASSWORD_LENGTH ||
    password.trim().length === 0 ||
    Buffer.byteLength(password, 'utf8') > MAX_PASSWORD_BYTES
  ) {
    return res.status(400).json({ message: 'Informe uma senha válida.' });
  }

  if (tenantId !== undefined) {
    if (typeof tenantId !== 'string' || !mongoose.isValidObjectId(tenantId.trim())) {
      return res.status(400).json({ message: 'O tenantId informado é inválido.' });
    }
  }

  return next();
};

const validateRegister = (req, res, next) => {
  if (!isPlainObject(req.body)) {
    return res.status(400).json({ message: 'Corpo da requisição inválido.' });
  }

  const { name, email, password, tenantId, registrationToken } = req.body;

  if (!isValidName(name)) {
    return res
      .status(400)
      .json({ message: `O nome deve ter entre ${MIN_NAME_LENGTH} e ${MAX_NAME_LENGTH} caracteres.` });
  }

  if (!isValidEmail(email)) {
    return res.status(400).json({ message: 'Informe um e-mail válido.' });
  }

  const passwordError = validatePasswordRules(password);
  if (passwordError) {
    return res.status(400).json({ message: passwordError });
  }

  if (typeof tenantId !== 'string' || !tenantId.trim()) {
    return res.status(400).json({ message: 'O tenantId é obrigatório.' });
  }

  if (!mongoose.isValidObjectId(tenantId.trim())) {
    return res.status(400).json({ message: 'O tenantId informado é inválido.' });
  }

  if (
    registrationToken !== undefined &&
    (typeof registrationToken !== 'string' || !/^[a-f\d]{64}$/i.test(registrationToken))
  ) {
    return res.status(400).json({ message: 'O código de registro informado é inválido.' });
  }

  return next();
};

const validateTenant = (req, res, next) => {
  if (!isPlainObject(req.body)) {
    return res.status(400).json({ message: 'Corpo da requisição inválido.' });
  }

  const { name, plan } = req.body;

  if (!isValidName(name)) {
    return res.status(400).json({
      message: `O nome do tenant deve ter entre ${MIN_NAME_LENGTH} e ${MAX_NAME_LENGTH} caracteres.`,
    });
  }

  if (!isValidPlanFormat(plan)) {
    return res.status(400).json({ message: 'Informe um plano válido.' });
  }

  return next();
};

const validateTenantUpdate = (req, res, next) => {
  if (!isPlainObject(req.body)) {
    return res.status(400).json({ message: 'Corpo da requisição inválido.' });
  }

  const { name, plan } = req.body;

  if (name === undefined && plan === undefined) {
    return res
      .status(400)
      .json({ message: 'Informe ao menos um campo para atualização (name ou plan).' });
  }

  if (name !== undefined && !isValidName(name)) {
    return res.status(400).json({
      message: `O nome do tenant deve ter entre ${MIN_NAME_LENGTH} e ${MAX_NAME_LENGTH} caracteres.`,
    });
  }

  if (plan !== undefined && !isValidPlanFormat(plan)) {
    return res.status(400).json({ message: 'Informe um plano válido.' });
  }

  return next();
};

const validateUserCreation = (req, res, next) => {
  if (!isPlainObject(req.body)) {
    return res.status(400).json({ message: 'Corpo da requisição inválido.' });
  }

  const { name, email, password, role } = req.body;

  if (!isValidName(name)) {
    return res
      .status(400)
      .json({ message: `O nome deve ter entre ${MIN_NAME_LENGTH} e ${MAX_NAME_LENGTH} caracteres.` });
  }

  if (!isValidEmail(email)) {
    return res.status(400).json({ message: 'Informe um e-mail válido.' });
  }

  const passwordError = validatePasswordRules(password);
  if (passwordError) {
    return res.status(400).json({ message: passwordError });
  }

  if (role !== undefined && !['admin', 'member'].includes(role)) {
    return res.status(400).json({ message: 'O papel (role) deve ser admin ou member.' });
  }

  return next();
};

const validateUserUpdate = (req, res, next) => {
  if (!isPlainObject(req.body)) {
    return res.status(400).json({ message: 'Corpo da requisição inválido.' });
  }

  const { name, email, password, role } = req.body;

  if (name === undefined && email === undefined && password === undefined && role === undefined) {
    return res.status(400).json({
      message: 'Informe ao menos um campo para atualização (name, email, password ou role).',
    });
  }

  if (name !== undefined && !isValidName(name)) {
    return res
      .status(400)
      .json({ message: `O nome deve ter entre ${MIN_NAME_LENGTH} e ${MAX_NAME_LENGTH} caracteres.` });
  }

  if (email !== undefined && !isValidEmail(email)) {
    return res.status(400).json({ message: 'Informe um e-mail válido.' });
  }

  if (password !== undefined) {
    const passwordError = validatePasswordRules(password);
    if (passwordError) {
      return res.status(400).json({ message: passwordError });
    }
  }

  if (role !== undefined && !['admin', 'member'].includes(role)) {
    return res.status(400).json({ message: 'O papel (role) deve ser admin ou member.' });
  }

  return next();
};

module.exports = {
  isValidEmail,
  validatePasswordRules,
  validateLogin,
  validateRegister,
  validateTenant,
  validateTenantUpdate,
  validateUserCreation,
  validateUserUpdate,
};
