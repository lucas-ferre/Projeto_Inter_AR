const parseAllowedOrigins = () => {
  const raw = process.env.CORS_ORIGIN;
  if (!raw || raw.trim() === '*') {
    return '*';
  }

  return raw
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);
};

module.exports = (req, res, next) => {
  const allowedOrigins = parseAllowedOrigins();
  const requestOrigin = req.headers.origin;

  if (allowedOrigins === '*') {
    res.setHeader('Access-Control-Allow-Origin', '*');
  } else if (requestOrigin && allowedOrigins.includes(requestOrigin)) {
    res.setHeader('Access-Control-Allow-Origin', requestOrigin);
    res.setHeader('Vary', 'Origin');
  }

  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader(
    'Access-Control-Expose-Headers',
    'X-Total-Count, RateLimit-Limit, RateLimit-Remaining, RateLimit-Reset, Retry-After'
  );

  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }

  return next();
};
