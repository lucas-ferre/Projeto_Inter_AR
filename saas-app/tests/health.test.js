const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { isMongoReady } = require('../routes/health');

describe('MongoDB readiness check', () => {
  it('returns false without an open Mongoose connection', async () => {
    let pingCalled = false;
    const connection = {
      readyState: 0,
      db: {
        async command() {
          pingCalled = true;
        },
      },
    };

    assert.equal(await isMongoReady(connection), false);
    assert.equal(pingCalled, false);
  });

  it('returns true after a successful MongoDB ping', async () => {
    const connection = {
      readyState: 1,
      db: {
        async command(command) {
          assert.deepEqual(command, { ping: 1 });
          return { ok: 1 };
        },
      },
    };

    assert.equal(await isMongoReady(connection), true);
  });

  it('returns false when the ping fails or times out', async () => {
    const unavailable = {
      readyState: 1,
      db: {
        async command() {
          throw new Error('connection unavailable');
        },
      },
    };
    const commandRejected = {
      readyState: 1,
      db: {
        async command() {
          return { ok: 0 };
        },
      },
    };
    const hanging = {
      readyState: 1,
      db: {
        command() {
          return new Promise(() => {});
        },
      },
    };

    assert.equal(await isMongoReady(unavailable), false);
    assert.equal(await isMongoReady(commandRejected), false);
    assert.equal(await isMongoReady(hanging, 10), false);
  });
});
