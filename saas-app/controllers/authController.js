const { loginUser, registerUser } = require('../services/authService');

exports.login = async (req, res, next) => {
  try {
    const { email, password, tenantId } = req.body;
    const result = await loginUser({ email, password, tenantId });
    return res.json({ token: result.token, user: result.user });
  } catch (error) {
    return next(error);
  }
};

exports.register = async (req, res, next) => {
  try {
    const { name, email, password, tenantId, registrationToken } = req.body;
    const user = await registerUser({ name, email, password, tenantId, registrationToken });
    return res.status(201).json(user);
  } catch (error) {
    return next(error);
  }
};
