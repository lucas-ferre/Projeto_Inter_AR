const express = require('express');
const mongoose = require('mongoose');

const router = express.Router();
const MONGO_PING_TIMEOUT_MS = 1000;

const isMongoReady = async (connection = mongoose.connection, timeoutMs = MONGO_PING_TIMEOUT_MS) => {
  if (connection?.readyState !== 1 || typeof connection?.db?.command !== 'function') {
    return false;
  }

  let timeout;
  try {
    const ping = Promise.resolve()
      .then(() => connection.db.command({ ping: 1 }))
      .then(
        (result) => result?.ok === 1,
        () => false
      );
    const timedOut = new Promise((resolve) => {
      timeout = setTimeout(() => resolve(false), timeoutMs);
    });

    return await Promise.race([ping, timedOut]);
  } finally {
    clearTimeout(timeout);
  }
};

router.get('/live', (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  return res.status(200).json({ status: 'ok' });
});

router.get('/ready', async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const ready = await isMongoReady();

  if (!ready) {
    return res.status(503).json({
      status: 'not_ready',
      dependencies: { mongodb: 'unavailable' },
    });
  }

  return res.status(200).json({
    status: 'ready',
    dependencies: { mongodb: 'ok' },
  });
});

module.exports = router;
module.exports.isMongoReady = isMongoReady;
