const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env'), quiet: true });

const express = require('express');
const { mongoose, connectDatabase } = require('./config/db');
const { bootstrapDatabase } = require('./services/bootstrapService');
const planRoutes = require('./routes/plan');
const authRoutes = require('./routes/auth');
const userRoutes = require('./routes/user');
const tenantRoutes = require('./routes/tenant');
const healthRoutes = require('./routes/health');
const securityHeaders = require('./middleware/securityHeaders');
const corsMiddleware = require('./middleware/cors');
const { createRateLimiter } = require('./middleware/rateLimiter');
const errorHandler = require('./middleware/errorHandler');
const { sanitizeSensitiveText } = require('./middleware/errorHandler');

const app = express();

app.disable('x-powered-by');

if (process.env.TRUST_PROXY) {
  const trustValue =
    process.env.TRUST_PROXY === 'true'
      ? 1
      : Number.isNaN(Number(process.env.TRUST_PROXY))
        ? process.env.TRUST_PROXY
        : Number(process.env.TRUST_PROXY);
  app.set('trust proxy', trustValue);
}

const apiLimiter = createRateLimiter({ scope: 'global', windowMs: 60 * 1000, maxRequests: 120 });

app.use(securityHeaders);
app.use(corsMiddleware);
app.use('/health', healthRoutes);
app.use(apiLimiter);
app.use(express.json({ limit: '10kb' }));

app.use('/plans', planRoutes);
app.use('/auth', authRoutes);
app.use('/users', userRoutes);
app.use('/tenants', tenantRoutes);

app.use((req, res) => {
  res.status(404).json({ message: 'Rota não encontrada.' });
});

app.use(errorHandler);

const PORT = process.env.PORT || 3000;
const MIN_JWT_SECRET_LENGTH = 32;

const registerGracefulShutdown = (server) => {
  let shuttingDown = false;

  const shutdown = (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;

    console.log(`\n[${signal}] Encerrando servidor de forma segura...`);
    server.close(async () => {
      try {
        if (mongoose.connection.readyState !== 0) {
          await mongoose.connection.close();
        }
        process.exit(0);
      } catch (err) {
        console.error('Erro ao fechar conexão com MongoDB:', sanitizeSensitiveText(err?.message));
        process.exit(1);
      }
    });

    setTimeout(() => {
      process.exit(1);
    }, 10000).unref();
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
};

const startServer = async () => {
  const rateLimitStore = (process.env.RATE_LIMIT_STORE || 'mongodb').trim().toLowerCase();
  if (!['mongodb', 'memory'].includes(rateLimitStore)) {
    console.error('RATE_LIMIT_STORE deve ser mongodb ou memory.');
    process.exit(1);
  }

  if (
    process.env.NODE_ENV === 'production' &&
    (process.env.ALLOW_PUBLIC_MULTI_REGISTER === 'true' ||
      process.env.ALLOW_DIRECT_PLAN_CHANGE === 'true')
  ) {
    console.error(
      'ALLOW_PUBLIC_MULTI_REGISTER e ALLOW_DIRECT_PLAN_CHANGE devem permanecer desativados em produção.'
    );
    process.exit(1);
  }

  if (!process.env.JWT_SECRET || process.env.JWT_SECRET.trim().length < MIN_JWT_SECRET_LENGTH) {
    if (process.stdin.isTTY) {
      const readline = require('readline');
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      const answer = await new Promise((resolve) => {
        rl.question(
          `\n[server] JWT_SECRET ausente ou fraca no .env (mínimo de ${MIN_JWT_SECRET_LENGTH} caracteres).\nDeseja executar o script para gerar e configurar a chave automaticamente agora? (S/n): `,
          (ans) => {
            rl.close();
            resolve(ans.trim().toLowerCase());
          }
        );
      });

      const wantsAutoSetup = answer === '' || ['s', 'sim', 'y', 'yes'].includes(answer);
      if (wantsAutoSetup) {
        const { execFileSync } = require('child_process');
        execFileSync(process.execPath, [path.join(__dirname, 'scripts', 'setup-env.js'), '--yes'], {
          stdio: 'inherit',
        });
        require('dotenv').config({ path: path.join(__dirname, '.env'), override: true });
      }
    }

    if (!process.env.JWT_SECRET || process.env.JWT_SECRET.trim().length < MIN_JWT_SECRET_LENGTH) {
      console.error(
        `JWT_SECRET ausente ou fraca no arquivo .env (mínimo de ${MIN_JWT_SECRET_LENGTH} caracteres).`
      );
      process.exit(1);
    }
  }

  try {
    await connectDatabase();
    await bootstrapDatabase();
    const server = app.listen(PORT, () => console.log(`Servidor rodando na porta ${PORT}`));
    registerGracefulShutdown(server);
    return server;
  } catch (error) {
    console.error('Erro ao conectar ao MongoDB:', sanitizeSensitiveText(error.message));
    process.exit(1);
  }
};

if (require.main === module) {
  startServer();
}

module.exports = app;
