const { listPlans, getPlanByName } = require('../services/planService');

exports.listPlans = async (req, res, next) => {
  try {
    const plans = await listPlans();
    return res.json(plans);
  } catch (error) {
    return next(error);
  }
};

exports.getPlan = async (req, res, next) => {
  try {
    const plan = await getPlanByName(req.params.name);
    return res.json(plan);
  } catch (error) {
    return next(error);
  }
};
