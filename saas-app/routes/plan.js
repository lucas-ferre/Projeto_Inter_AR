const express = require('express');
const { listPlans, getPlan } = require('../controllers/planController');

const router = express.Router();

router.get('/', listPlans);
router.get('/:name', getPlan);

module.exports = router;
