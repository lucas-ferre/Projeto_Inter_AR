module.exports = (req, res, next) => {
  if (!req.user || req.user.role !== 'admin') {
    return res.status(403).json({
      message: 'Acesso restrito a administradores do tenant.',
    });
  }

  return next();
};
