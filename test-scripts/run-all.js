const {
  ensureServerRunning,
  stopServerIfSpawned,
  c,
} = require('./test-utils');

const runSmoke = require('./test-smoke');
const runOnboarding = require('./test-onboarding');
const runRbac = require('./test-rbac');
const runIsolation = require('./test-isolation');
const runConcurrency = require('./test-concurrency');
const runRateLimit = require('./test-rate-limit');

const main = async () => {
  const globalStart = performance.now();

  console.log(`\n${c.bold}${c.blue}╔════════════════════════════════════════════════════════════════╗${c.reset}`);
  console.log(`${c.bold}${c.blue}║          SUÍTE COMPLETA DE SCRIPTS DE TESTE DO SISTEMA         ║${c.reset}`);
  console.log(`${c.bold}${c.blue}║        API SaaS Multitenant (Node.js + Express + MongoDB)      ║${c.reset}`);
  console.log(`${c.bold}${c.blue}╚════════════════════════════════════════════════════════════════╝${c.reset}`);

  await ensureServerRunning();

  const suites = [
    { name: '1. Smoke & Health Check', fn: runSmoke },
    { name: '2. Onboarding & Registration Token', fn: runOnboarding },
    { name: '3. Controle de Acesso (RBAC)', fn: runRbac },
    { name: '4. Isolamento Multitenant & Cross-Tenant', fn: runIsolation },
    { name: '5. Concorrência & Proteção de Admin', fn: runConcurrency },
    { name: '6. Rate Limiting & Cabeçalhos IETF', fn: runRateLimit },
  ];

  const results = [];

  for (const suite of suites) {
    try {
      const summary = await suite.fn();
      results.push({ name: suite.name, ...summary });
    } catch (error) {
      console.error(`\n${c.red}Erro inesperado na suíte ${suite.name}:${c.reset}`, error);
      results.push({
        name: suite.name,
        total: 1,
        passed: 0,
        failed: 1,
        duration: 0,
        error: error.message,
      });
    }
  }

  stopServerIfSpawned();

  const totalDuration = Math.round(performance.now() - globalStart);
  const totalPassed = results.reduce((acc, r) => acc + (r.passed || 0), 0);
  const totalFailed = results.reduce((acc, r) => acc + (r.failed || 0), 0);
  const totalSteps = totalPassed + totalFailed;

  console.log(`\n${c.bold}${c.cyan}================================================================${c.reset}`);
  console.log(`${c.bold}${c.cyan}  RELATÓRIO FINAL CONSOLIDADO DE EXECUÇÃO${c.reset}`);
  console.log(`${c.bold}${c.cyan}================================================================${c.reset}\n`);

  for (const r of results) {
    const badge =
      r.failed === 0
        ? `${c.green}✔ APROVADO${c.reset}`
        : `${c.red}✖ FALHA (${r.failed})${c.reset}`;
    const stats = `${r.passed}/${r.total} passos`;
    console.log(`  ${badge}  ${r.name.padEnd(42, ' ')} ${stats} (${r.duration}ms)`);
  }

  console.log(`\n${c.dim}----------------------------------------------------------------${c.reset}`);
  if (totalFailed === 0) {
    console.log(
      `  ${c.bold}${c.green}SUCESSO TOTAL: ${totalPassed} de ${totalSteps} passos aprovados em ${totalDuration}ms!${c.reset}\n`
    );
    process.exit(0);
  } else {
    console.log(
      `  ${c.bold}${c.red}ATENÇÃO: ${totalFailed} passo(s) falharam de um total de ${totalSteps} em ${totalDuration}ms.${c.reset}\n`
    );
    process.exit(1);
  }
};

main().catch((err) => {
  console.error('Falha crítica na orquestração dos testes:', err);
  stopServerIfSpawned();
  process.exit(1);
});
