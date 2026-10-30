const sanitizeSensitiveText = (text = '') =>
  String(text)
    .replace(/mongodb(\+srv)?:\/\/([^/\s]+)@/gi, 'mongodb$1://***:***@')
    .replace(/Bearer\s+[A-Za-z0-9\-_]+\.[A-Za-z0-9\-_]+\.[A-Za-z0-9\-_]+/gi, 'Bearer [REDACTED]');

module.exports = (err, req, res, next) => {
  if (res.headersSent) {
    return next(err);
  }

  if (!err || typeof err !== 'object') {
    return res.status(500).json({ message: 'Erro interno do servidor.' });
  }

  if (err instanceof SyntaxError && err.status === 400 && 'body' in err) {
    return res.status(400).json({ message: 'Corpo da requisição contém JSON inválido.' });
  }

  if (err.type === 'entity.too.large' || err.status === 413) {
    return res.status(413).json({ message: 'Corpo da requisição excede o limite permitido.' });
  }

  if (err.name === 'CastError') {
    return res.status(400).json({ message: 'Identificador informado é inválido.' });
  }

  if (err.name === 'ValidationError') {
    return res.status(400).json({ message: 'Dados inválidos na requisição.' });
  }

  if (err.code === 11000) {
    return res.status(409).json({
      message: 'Não foi possível concluir a operação com os dados informados.',
    });
  }

  if (err.isOperational && err.statusCode && err.statusCode < 500) {
    return res.status(err.statusCode).json({ message: err.message });
  }

  console.error(
    '[ErroInterno]',
    err.name || 'Error',
    sanitizeSensitiveText(err.message || 'Falha inesperada')
  );

  return res.status(500).json({ message: 'Erro interno do servidor.' });
};

module.exports.sanitizeSensitiveText = sanitizeSensitiveText;
