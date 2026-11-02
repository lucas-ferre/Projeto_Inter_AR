const mongoose = require('mongoose');

module.exports = (req, res, next) => {
  const { id } = req.params;

  if (!mongoose.isValidObjectId(id)) {
    return res.status(400).json({ message: 'ID do tenant inválido.' });
  }

  if (String(req.user.tenantId) !== String(id)) {
    return res.status(403).json({ message: 'Acesso negado aos dados de outro tenant.' });
  }

  return next();
};
