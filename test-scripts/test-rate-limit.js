const {
  ensureServerRunning,
  stopServerIfSpawned,
  apiRequest,
  assert,
  createTestRunner,
} = require('./test-utils');

const run = async () => {
  await ensureServerRunning();
  const runner = createTestRunner('TESTE 6: RATE LIMITING & PROTEÇÃO CONTRA ABUSO');

  await runner.step('6.1. Verifica decréscimo progressivo do cabeçalho RateLimit-Remaining', async () => {
    const res1 = await apiRequest('/plans');
    assert(res1.status === 200, 'Falha na 1ª requisição a /plans');
    const remaining1 = Number(res1.headers.get('ratelimit-remaining'));

    const res2 = await apiRequest('/plans');
    assert(res2.status === 200, 'Falha na 2ª requisição a /plans');
    const remaining2 = Number(res2.headers.get('ratelimit-remaining'));

    assert(
      remaining2 < remaining1 || remaining1 === 0,
      `RateLimit-Remaining deve decrescer (anterior: ${remaining1}, atual: ${remaining2})`
    );
  });

  await runner.step('6.2. Dispara requisições sequenciais até atingir limite e valida HTTP 429 Too Many Requests', async () => {
    // O tenantCreationLimiter tem limite de 15 requisições por minuto
    let reachedLimit = false;
    let retryAfterHeader = null;

    for (let i = 0; i < 22; i++) {
      const res = await apiRequest('/tenants', {
        method: 'POST',
        body: { name: `Teste Invalido Curto` },
      });

      if (res.status === 429) {
        reachedLimit = true;
        retryAfterHeader = res.headers.get('retry-after');
        assert(
          /Muitas tentativas/i.test(res.data?.message || ''),
          `Mensagem esperada no 429. Recebeu: ${res.data?.message}`
        );
        break;
      }
    }

    assert(reachedLimit, 'Deve receber status 429 após exceder a cota por minuto');
    assert(Boolean(retryAfterHeader), 'Resposta 429 deve conter o cabeçalho Retry-After');
    assert(Number(retryAfterHeader) >= 1, `Retry-After deve ser >= 1s, recebeu ${retryAfterHeader}`);
  });

  const summary = runner.finish();
  if (require.main === module) {
    stopServerIfSpawned();
    if (summary.failed > 0) {
      process.exit(1);
    }
  }
  return summary;
};

if (require.main === module) {
  run().catch((err) => {
    console.error('Erro fatal no teste:', err);
    stopServerIfSpawned();
    process.exit(1);
  });
}

module.exports = run;
