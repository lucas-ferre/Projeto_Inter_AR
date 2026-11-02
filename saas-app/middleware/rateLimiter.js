const mongoose = require('mongoose');
const RateLimitBucket = require('../models/RateLimitBucket');

const createMemoryRateLimitStore = ({ windowMs = 60 * 1000, maxEntries = 10000 } = {}) => {
  const hits = new Map();

  const evictExpired = (now) => {
    for (const [key, record] of hits.entries()) {
      if (now >= record.resetAt) {
        hits.delete(key);
      }
    }
  };

  const cleanupTimer = setInterval(() => {
    evictExpired(Date.now());
  }, windowMs);

  if (typeof cleanupTimer.unref === 'function') {
    cleanupTimer.unref();
  }

  return {
    async increment(key, currentWindowMs) {
      const now = Date.now();
      let record = hits.get(key);

      if (!record || now >= record.resetAt) {
        if (hits.size >= maxEntries && !hits.has(key)) {
          evictExpired(now);
          if (hits.size >= maxEntries) {
            const oldestKey = hits.keys().next().value;
            if (oldestKey !== undefined) {
              hits.delete(oldestKey);
            }
          }
        }

        record = { count: 1, resetAt: now + currentWindowMs };
        hits.set(key, record);
        return { count: record.count, resetAt: record.resetAt };
      }

      record.count += 1;
      return { count: record.count, resetAt: record.resetAt };
    },
  };
};

const createMongoRateLimitStore = () => {
  const runAtomicIncrement = async (key, windowMs) => {
    const now = Date.now();
    const nowDate = new Date(now);
    const nextResetDate = new Date(now + windowMs);

    const doc = await RateLimitBucket.findOneAndUpdate(
      { key },
      [
        {
          $set: {
            count: {
              $cond: [
                { $or: [{ $not: ['$resetAt'] }, { $lte: ['$resetAt', nowDate] }] },
                1,
                { $add: ['$count', 1] },
              ],
            },
            resetAt: {
              $cond: [
                { $or: [{ $not: ['$resetAt'] }, { $lte: ['$resetAt', nowDate] }] },
                nextResetDate,
                '$resetAt',
              ],
            },
          },
        },
      ],
      { upsert: true, returnDocument: 'after', updatePipeline: true }
    ).lean();

    return {
      count: doc.count,
      resetAt: new Date(doc.resetAt).getTime(),
    };
  };

  return {
    async increment(key, windowMs) {
      try {
        return await runAtomicIncrement(key, windowMs);
      } catch (error) {
        // Caso duas instâncias façam o primeiro upsert simultâneo da mesma chave
        if (error && error.code === 11000) {
          return runAtomicIncrement(key, windowMs);
        }
        throw error;
      }
    },
  };
};

const createRateLimiter = ({
  scope = 'default',
  windowMs = 60 * 1000,
  maxRequests = 25,
  maxEntries = 10000,
  store,
  failClosed = false,
} = {}) => {
  const memoryFallbackStore = createMemoryRateLimitStore({ windowMs, maxEntries });
  const mongoStore = createMongoRateLimitStore();
  let lastFallbackWarningAt = 0;
  let storeUnavailableSince = null;
  let failuresSinceLastLog = 0;
  let failuresDuringOutage = 0;

  const logFallbackWarning = (reason) => {
    const warningTime = Date.now();
    if (storeUnavailableSince === null) {
      storeUnavailableSince = warningTime;
    }
    failuresSinceLastLog += 1;
    failuresDuringOutage += 1;

    if (warningTime - lastFallbackWarningAt >= 60 * 1000) {
      lastFallbackWarningAt = warningTime;
      const failureCount = failuresSinceLastLog;
      failuresSinceLastLog = 0;
      if (failClosed) {
        console.error(
          `[RateLimit] event=store_unavailable scope=${scope} mode=fail-closed; bloqueando requisições com 503 (fail-closed). falhasNaJanela=${failureCount} indisponivelMs=${warningTime - storeUnavailableSince}`,
          reason || 'Disconnected'
        );
      } else {
        console.error(
          `[RateLimit] event=store_unavailable scope=${scope} mode=fail-open; usando memória local (fail-open). falhasNaJanela=${failureCount} indisponivelMs=${warningTime - storeUnavailableSince}`,
          reason || 'Disconnected'
        );
      }
    }
  };

  const logStoreRecovery = () => {
    if (storeUnavailableSince === null) {
      return;
    }

    console.info(
      `[RateLimit] event=store_recovered scope=${scope} falhasDuranteIndisponibilidade=${failuresDuringOutage} indisponivelMs=${Date.now() - storeUnavailableSince}`
    );
    storeUnavailableSince = null;
    failuresSinceLastLog = 0;
    failuresDuringOutage = 0;
    lastFallbackWarningAt = 0;
  };

  const resolveActiveStore = () => {
    if (store && typeof store.increment === 'function') {
      return store;
    }

    const configuredStore = (process.env.RATE_LIMIT_STORE || 'mongodb').trim().toLowerCase();
    if (configuredStore === 'mongodb') {
      if (mongoose.connection.readyState === 1) {
        return mongoStore;
      }
      logFallbackWarning(`readyState=${mongoose.connection.readyState}`);
      if (failClosed) {
        return null;
      }
    }

    return memoryFallbackStore;
  };

  return async (req, res, next) => {
    const ip = req.ip || req.socket?.remoteAddress || 'unknown';
    const bucketKey = `${scope}:${ip}`;
    const activeStore = resolveActiveStore();

    if (!activeStore) {
      res.setHeader('Retry-After', '5');
      return res.status(503).json({
        message: 'Serviço temporariamente indisponível. Tente novamente em instantes.',
      });
    }

    let record;
    try {
      record = await activeStore.increment(bucketKey, windowMs);
      if (activeStore === mongoStore) {
        logStoreRecovery();
      }
    } catch (error) {
      logFallbackWarning(error?.name || 'Error');
      if (failClosed) {
        res.setHeader('Retry-After', '5');
        return res.status(503).json({
          message: 'Serviço temporariamente indisponível. Tente novamente em instantes.',
        });
      }
      record = await memoryFallbackStore.increment(bucketKey, windowMs);
    }

    const now = Date.now();
    const resetSeconds = Math.max(1, Math.ceil((record.resetAt - now) / 1000));
    const remaining = Math.max(0, maxRequests - record.count);

    res.setHeader('RateLimit-Limit', String(maxRequests));
    res.setHeader('RateLimit-Remaining', String(remaining));
    res.setHeader('RateLimit-Reset', String(resetSeconds));

    if (record.count > maxRequests) {
      res.setHeader('Retry-After', String(resetSeconds));
      return res.status(429).json({
        message: 'Muitas tentativas em curto intervalo. Aguarde um momento e tente novamente.',
      });
    }

    return next();
  };
};

module.exports = {
  createRateLimiter,
};
