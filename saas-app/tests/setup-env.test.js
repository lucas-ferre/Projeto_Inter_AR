const { afterEach, describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const sourceScript = path.resolve(__dirname, '../scripts/setup-env.js');
const sourceExample = path.resolve(__dirname, '../.env.example');
const fixtures = new Set();

const createFixture = (existingEnv) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'saas-setup-env-'));
  fixtures.add(root);

  const appDir = path.join(root, 'saas-app');
  const scriptsDir = path.join(appDir, 'scripts');
  fs.mkdirSync(scriptsDir, { recursive: true });
  fs.copyFileSync(sourceScript, path.join(scriptsDir, 'setup-env.js'));
  fs.copyFileSync(sourceExample, path.join(appDir, '.env.example'));

  const envPath = path.join(appDir, '.env');
  if (existingEnv !== undefined) {
    fs.writeFileSync(envPath, existingEnv, 'utf8');
  }

  return { envPath, scriptPath: path.join(scriptsDir, 'setup-env.js') };
};

const runSetup = ({ scriptPath, args = [], input = '' }) =>
  spawnSync(process.execPath, [scriptPath, ...args], {
    encoding: 'utf8',
    input,
    timeout: 5000,
  });

afterEach(() => {
  for (const fixture of fixtures) {
    fs.rmSync(fixture, { recursive: true, force: true });
    fixtures.delete(fixture);
  }
});

describe('setup-env confirmation behavior', () => {
  it('refuses to create .env on non-interactive EOF without --yes', () => {
    const fixture = createFixture();

    const result = runSetup(fixture);

    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /Confirmação interativa indisponível/);
    assert.equal(fs.existsSync(fixture.envPath), false);
  });

  it('does not replace an existing JWT_SECRET on non-interactive --force without --yes', () => {
    const originalEnv = 'PORT=3000\nJWT_SECRET=an-existing-secret-that-must-not-change-123456\n';
    const fixture = createFixture(originalEnv);

    const result = runSetup({ ...fixture, args: ['--force'] });

    assert.equal(result.status, 1, result.stderr);
    assert.equal(fs.readFileSync(fixture.envPath, 'utf8'), originalEnv);
  });

  it('creates .env with a generated secret when explicitly passed --yes', () => {
    const fixture = createFixture();

    const result = runSetup({ ...fixture, args: ['--yes'] });
    const content = fs.readFileSync(fixture.envPath, 'utf8');
    const secret = content.match(/^JWT_SECRET=(.+)$/m)?.[1];

    assert.equal(result.status, 0, result.stderr);
    assert.match(secret || '', /^[a-f\d]{128}$/i);
    assert.ok(!result.stdout.includes(secret));
  });

  it('preserves other settings while rotating a secret with --yes --force', () => {
    const originalEnv = 'PORT=4321\nJWT_SECRET=an-existing-secret-that-must-not-change-123456\n';
    const fixture = createFixture(originalEnv);

    const result = runSetup({ ...fixture, args: ['--yes', '--force'] });
    const content = fs.readFileSync(fixture.envPath, 'utf8');
    const secret = content.match(/^JWT_SECRET=(.+)$/m)?.[1];

    assert.equal(result.status, 0, result.stderr);
    assert.match(secret || '', /^[a-f\d]{128}$/i);
    assert.notEqual(secret, 'an-existing-secret-that-must-not-change-123456');
    assert.match(content, /^PORT=4321$/m);
  });
});
