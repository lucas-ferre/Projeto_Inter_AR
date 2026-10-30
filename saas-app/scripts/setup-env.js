const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const saasAppDir = path.resolve(__dirname, '..');
const envPath = path.join(saasAppDir, '.env');
const envExamplePath = path.join(saasAppDir, '.env.example');

const MIN_KEY_LENGTH = 32;
const PLACEHOLDER_PATTERN = /substitua_por_uma_chave/i;

const args = process.argv.slice(2);
const force = args.includes('--force') || args.includes('-f');
const keyArgIndex = args.findIndex((arg) => arg === '--key' || arg === '-k');
const customKey = keyArgIndex !== -1 && args[keyArgIndex + 1] ? args[keyArgIndex + 1].trim() : null;

const generateSecureKey = () => crypto.randomBytes(64).toString('hex');

const isWeakOrPlaceholder = (val) => {
  if (!val || typeof val !== 'string') return true;
  const trimmed = val.trim();
  return trimmed.length < MIN_KEY_LENGTH || PLACEHOLDER_PATTERN.test(trimmed);
};

const run = () => {
  let selectedKey;

  if (customKey) {
    if (customKey.length < MIN_KEY_LENGTH) {
      console.error(
        `[setup-env] Erro: A chave fornecida deve ter no mínimo ${MIN_KEY_LENGTH} caracteres (recebeu ${customKey.length}).`
      );
      process.exit(1);
    }
    selectedKey = customKey;
  } else {
    selectedKey = generateSecureKey();
  }

  // 1. Se o arquivo .env não existir, cria a partir de .env.example
  if (!fs.existsSync(envPath)) {
    if (!fs.existsSync(envExamplePath)) {
      console.error('[setup-env] Erro: Arquivo .env.example não foi encontrado.');
      process.exit(1);
    }

    const template = fs.readFileSync(envExamplePath, 'utf8').replace(/\r\n/g, '\n');
    let newContent;

    if (/^JWT_SECRET=/m.test(template)) {
      newContent = template.replace(/^JWT_SECRET=.*$/m, `JWT_SECRET=${selectedKey}`);
    } else {
      newContent = `${template}\nJWT_SECRET=${selectedKey}\n`;
    }

    fs.writeFileSync(envPath, newContent, { encoding: 'utf8', mode: 0o600 });
    console.log('[setup-env] Arquivo .env criado com sucesso a partir de .env.example.');
    console.log(`[setup-env] JWT_SECRET gerado e injetado com sucesso (${selectedKey.length} caracteres).`);
    return;
  }

  // 2. Se o .env já existir, inspeciona e atualiza a chave JWT_SECRET
  const currentEnv = fs.readFileSync(envPath, 'utf8').replace(/\r\n/g, '\n');
  const match = currentEnv.match(/^JWT_SECRET=(.*)$/m);
  const currentSecret = match ? match[1].trim() : null;

  if (currentSecret && !isWeakOrPlaceholder(currentSecret) && !force && !customKey) {
    console.log('[setup-env] O arquivo .env já possui uma JWT_SECRET segura configurada.');
    console.log('[setup-env] Nenhuma alteração foi realizada. Para forçar nova geração, use: npm run setup:env -- --force');
    return;
  }

  let updatedEnv;
  if (match) {
    updatedEnv = currentEnv.replace(/^JWT_SECRET=.*$/m, `JWT_SECRET=${selectedKey}`);
  } else {
    updatedEnv = `${currentEnv.trimEnd()}\nJWT_SECRET=${selectedKey}\n`;
  }

  fs.writeFileSync(envPath, updatedEnv, { encoding: 'utf8', mode: 0o600 });

  if (force) {
    console.log(`[setup-env] JWT_SECRET sobrescrita com sucesso (--force, ${selectedKey.length} caracteres).`);
  } else {
    console.log(`[setup-env] JWT_SECRET gerada e injetada no .env com sucesso (${selectedKey.length} caracteres).`);
  }
};

run();
