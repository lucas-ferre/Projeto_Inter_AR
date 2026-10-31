const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { createRateLimiter } = require('../middleware/rateLimiter');

const invoke = (middleware, ip) =>
  new Promise((resolve) => {
    const headers = {};
    const response = {
      statusCode: 200,
      setHeader(key, value) {
        headers[key.toLowerCase()] = value;
      },
      status(code) {
        this.statusCode = code;
        return this;
      },
      json(payload) {
        this.payload = payload;
        resolve({ allowed: false, statusCode: this.statusCode, headers, payload });
      },
    };

    middleware({ ip }, response, () => {
      resolve({ allowed: true, statusCode: response.statusCode, headers });
    });
  });

describe('rate limiter store failure behavior', () => {
  it('fails closed with 503 when configured to protect authentication routes', async () => {
    const middleware = createRateLimiter({
      scope: 'unit-auth-fail-closed',
      store: {
        async increment() {
          throw Object.assign(new Error('store unavailable'), { name: 'MongoNetworkError' });
        },
      },
      failClosed: true,
    });

    const originalConsoleError = console.error;
    console.error = () => {};
    try {
      const result = await invoke(middleware, '192.0.2.1');

      assert.equal(result.allowed, false);
      assert.equal(result.statusCode, 503);
      assert.equal(result.headers['retry-after'], '5');
      assert.match(result.payload.message, /temporariamente indisponível/i);
    } finally {
      console.error = originalConsoleError;
    }
  });

  it('keeps the local fallback for routes configured to remain available', async () => {
    const middleware = createRateLimiter({
      scope: 'unit-memory-fallback',
      maxRequests: 1,
      store: {
        async increment() {
          throw Object.assign(new Error('store unavailable'), { name: 'MongoNetworkError' });
        },
      },
    });

    const originalConsoleError = console.error;
    console.error = () => {};
    try {
      const first = await invoke(middleware, '192.0.2.2');
      const second = await invoke(middleware, '192.0.2.2');

      assert.equal(first.allowed, true);
      assert.equal(second.allowed, false);
      assert.equal(second.statusCode, 429);
    } finally {
      console.error = originalConsoleError;
    }
  });
});
