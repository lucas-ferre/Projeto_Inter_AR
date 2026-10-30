const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');
const User = require('../models/User');
const Tenant = require('../models/Tenant');

const BEARER_HEADER_REGEX = /^Bearer\s+(\S+)$/i;

const sendUnauthorized = (res, message) => {
  res.setHeader('WWW-Authenticate', 'Bearer');
  return res.status(401).json({ message });
};

module.exports = async (req, res, next) => {
  const authHeader = req.headers.authorization;

  if (typeof authHeader !== 'string') {
    return sendUnauthorized(res, 'Token ausente ou inválido.');
  }

  const match = BEARER_HEADER_REGEX.exec(authHeader.trim());
  if (!match || !match[1]) {
    return sendUnauthorized(res, 'Token ausente ou inválido.');
  }

  const token = match[1];

  let decoded;
  try {
    decoded = jwt.verify(token, process.env.JWT_SECRET, { algorithms: ['HS256'] });
  } catch {
    return sendUnauthorized(res, 'Token inválido.');
  }

  if (
    !decoded ||
    typeof decoded !== 'object' ||
    !decoded.userId ||
    !decoded.tenantId ||
    !mongoose.isValidObjectId(String(decoded.userId)) ||
    !mongoose.isValidObjectId(String(decoded.tenantId))
  ) {
    return sendUnauthorized(res, 'Token inválido.');
  }

  try {
    const [activeUser, tenantExists] = await Promise.all([
      User.findOne({
        _id: decoded.userId,
        tenantId: String(decoded.tenantId),
      })
        .select('_id tenantId role')
        .lean(),
      Tenant.exists({ _id: decoded.tenantId, status: { $ne: 'deleting' } }),
    ]);

    if (!activeUser || !tenantExists) {
      return sendUnauthorized(res, 'Sessão inválida ou expirada.');
    }

    req.user = {
      userId: String(activeUser._id),
      tenantId: String(activeUser.tenantId),
      role: activeUser.role || 'member',
    };

    return next();
  } catch (error) {
    return next(error);
  }
};
