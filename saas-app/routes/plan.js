const express = require('express');
const { listPlans, getPlanByName } = require('../services/planService');

const router = express.Router();

router.get('/', async (req, res, next) => {
  try {
    const plans = await listPlans();
    return res.json(plans);
  } catch (error) {
    return next(error);
  }
});

router.get('/:name', async (req, res, next) => {
  try {
    const plan = await getPlanByName(req.params.name);
    return res.json(plan);
  } catch (error) {
    return next(error);
  }
});

module.exports = router;
