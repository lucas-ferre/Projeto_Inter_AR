const path = require('path');
const { spawn } = require('child_process');

const API_URL = process.env.API_URL || 'http://127.0.0.1:3000';
const saasAppDir = path.resolve(__dirname, '..', 'saas-app');

const isColorSupported =
  Boolean(process.stdout.isTTY) &&
  !process.env.NO_COLOR &&
  (process.env.TERM !== 'dumb' || Boolean(process.env.CI));

const c = {
  reset: isColorSupported ? '\x1b[0m' : '',
  bold: isColorSupported ? '\x1b[1m' : '',
  dim: isColorSupported ? '\x1b[2m' : '',
  green: isColorSupported ? '\x1b[32m' : '',
  red: isColorSupported ? '\x1b[31m' : '',
  yellow: isColorSupported ? '\x1b[33m' : '',
  blue: isColorSupported ? '\x1b[34m' : '',
  cyan: isColorSupported ? '\x1b[36m' : '',
};

let spawnedServerProcess = null;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const isServerUp = async () => {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 1500);
    const res = await fetch(`${API_URL}/health/ready`, { signal: controller.signal });
    clearTimeout(timeout);
    return res.status === 200;
  } catch {
    return false;
  }
};

const ensureServerRunning = async () => {
  if (await isServerUp()) {
    return { spawned: false };
  }

  console.log(`${c.dim}[setup] Servidor em ${API_URL} não detectado. Iniciando processo local...${c.reset}`);

  spawnedServerProcess = spawn(process.execPath, ['server.js'], {
    cwd: saasAppDir,
    stdio: 'ignore',
    env: { ...process.env, PORT: '3000' },
  });

  const stopSpawned = () => {
    if (spawnedServerProcess && !spawnedServerProcess.killed) {
      try {
        spawnedServerProcess.kill();
      } catch {}
    }
  };

  process.on('exit', stopSpawned);
  process.on('SIGINT', () => {
    stopSpawned();
    process.exit(130);
  });
  process.on('SIGTERM', () => {
    stopSpawned();
    process.exit(143);
  });

  const maxWaitMs = 25000;
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    await sleep(400);
    if (await isServerUp()) {
      console.log(`${c.green}✔ Servidor iniciado com sucesso para os testes.${c.reset}\n`);
      return { spawned: true };
    }
  }

  throw new Error(
    `Não foi possível conectar ao servidor em ${API_URL} após ${Math.round(maxWaitMs / 1000)}s. Certifique-se de que o MongoDB está rodando e execute 'npm start' em saas-app.`
  );
};

const stopServerIfSpawned = () => {
  if (spawnedServerProcess && !spawnedServerProcess.killed) {
    try {
      spawnedServerProcess.kill();
      spawnedServerProcess = null;
    } catch {}
  }
};

const apiRequest = async (endpoint, { method = 'GET', token, body, headers = {} } = {}) => {
  const url = `${API_URL}${endpoint.startsWith('/') ? endpoint : `/${endpoint}`}`;
  const reqHeaders = { ...headers };

  let reqBody = undefined;
  if (body !== undefined) {
    reqHeaders['Content-Type'] = 'application/json';
    reqBody = typeof body === 'string' ? body : JSON.stringify(body);
  }

  if (token) {
    reqHeaders['Authorization'] = `Bearer ${token}`;
  }

  const response = await fetch(url, {
    method,
    headers: reqHeaders,
    body: reqBody,
  });

  let data = null;
  const contentType = response.headers.get('content-type') || '';
  if (contentType.includes('application/json')) {
    data = await response.json();
  } else {
    data = await response.text();
  }

  return {
    status: response.status,
    headers: response.headers,
    data,
    ok: response.ok,
  };
};

const assert = (condition, message) => {
  if (!condition) {
    throw new Error(message || 'Falha na asserção');
  }
};

const createTestRunner = (suiteTitle) => {
  const steps = [];

  console.log(`\n${c.bold}${c.cyan}================================================================${c.reset}`);
  console.log(`${c.bold}${c.cyan}  ${suiteTitle}${c.reset}`);
  console.log(`${c.bold}${c.cyan}================================================================${c.reset}\n`);

  return {
    async step(name, fn) {
      const startTime = performance.now();
      try {
        await fn();
        const duration = Math.round(performance.now() - startTime);
        console.log(`  ${c.green}✔ PASS${c.reset}  ${name} ${c.dim}(${duration}ms)${c.reset}`);
        steps.push({ name, passed: true, duration });
      } catch (error) {
        const duration = Math.round(performance.now() - startTime);
        console.log(`  ${c.red}✖ FAIL${c.reset}  ${name} ${c.dim}(${duration}ms)${c.reset}`);
        console.log(`         ${c.red}${error.message || error}${c.reset}`);
        steps.push({ name, passed: false, duration, error: error.message || String(error) });
      }
    },

    finish() {
      const passedCount = steps.filter((s) => s.passed).length;
      const failedCount = steps.filter((s) => !s.passed).length;
      const totalDuration = steps.reduce((acc, s) => acc + s.duration, 0);

      console.log(`\n${c.dim}----------------------------------------------------------------${c.reset}`);
      if (failedCount === 0) {
        console.log(
          `  ${c.bold}${c.green}TODOS OS PASSOS APROVADOS (${passedCount}/${steps.length}) em ${totalDuration}ms${c.reset}\n`
        );
      } else {
        console.log(
          `  ${c.bold}${c.red}FALHAS ENCONTRADAS: ${failedCount} de ${steps.length} passos falharam (em ${totalDuration}ms)${c.reset}\n`
        );
      }

      return {
        suiteTitle,
        total: steps.length,
        passed: passedCount,
        failed: failedCount,
        duration: totalDuration,
      };
    },
  };
};

module.exports = {
  API_URL,
  c,
  sleep,
  isServerUp,
  ensureServerRunning,
  stopServerIfSpawned,
  apiRequest,
  assert,
  createTestRunner,
};
