const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const rootDir = path.resolve(__dirname, '..');
const saasAppDir = path.join(rootDir, 'saas-app');
const envExamplePath = path.join(saasAppDir, '.env.example');
const envPath = path.join(saasAppDir, '.env');

console.log('[devcontainer] Instalando dependências em saas-app...');
const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';
execFileSync(npmCmd, ['install'], { cwd: saasAppDir, stdio: 'inherit' });

if (!fs.existsSync(envPath)) {
  const jwtSecret = crypto.randomBytes(64).toString('hex');
  const template = fs.readFileSync(envExamplePath, 'utf8').replace(/\r\n/g, '\n');

  const configuredEnv = template
    .replace(/^JWT_SECRET=.*$/m, `JWT_SECRET=${jwtSecret}`)
    .replace(/^TRUST_PROXY=.*$/m, 'TRUST_PROXY=1');

  fs.writeFileSync(envPath, configuredEnv, { encoding: 'utf8', mode: 0o600 });
  console.log(
    '[devcontainer] Arquivo saas-app/.env criado automaticamente com JWT_SECRET seguro e TRUST_PROXY=1.'
  );
} else {
  console.log('[devcontainer] Arquivo saas-app/.env já existe e foi preservado.');
}

console.log('\n[devcontainer] Ambiente pronto!');
console.log('  - Rodar testes:   cd saas-app && npm test');
console.log('  - Iniciar API:    cd saas-app && npm start');
