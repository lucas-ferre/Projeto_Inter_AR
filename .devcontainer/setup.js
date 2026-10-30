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
const nodeCmd = 'node';
execFileSync(npmCmd, ['install'], { cwd: saasAppDir, stdio: 'inherit' });

console.log('[devcontainer] Configurando saas-app/.env...');
execFileSync(nodeCmd, ['scripts/setup-env.js', '--yes'], { cwd: saasAppDir, stdio: 'inherit' });

if (fs.existsSync(envPath)) {
  let envContent = fs.readFileSync(envPath, 'utf8');
  if (/^TRUST_PROXY=$/m.test(envContent) || !/^TRUST_PROXY=/m.test(envContent)) {
    envContent = envContent.replace(/^TRUST_PROXY=.*$/m, 'TRUST_PROXY=1');
    fs.writeFileSync(envPath, envContent, 'utf8');
    console.log('[devcontainer] TRUST_PROXY configurado para 1 (proxy reverso do Codespaces).');
  }
}

console.log('\n[devcontainer] Ambiente pronto!');
console.log('  - Rodar testes:   cd saas-app && npm test');
console.log('  - Iniciar API:    cd saas-app && npm start');
