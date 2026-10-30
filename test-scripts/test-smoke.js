const {
  ensureServerRunning,
  stopServerIfSpawned,
  apiRequest,
  assert,
  createTestRunner,
} = require('./test-utils');

const run = async () => {
  await ensureServerRunning();
  const runner = createTestRunner('TESTE 1: SMOKE & HEALTH CHECK DA API');

  await runner.step('1.1. Consulta lista de planos cadastrados no MongoDB (/plans)', async () => {
    const res = await apiRequest('/plans');
    assert(res.status === 200, `Esperava status 200, recebeu ${res.status}`);
    assert(Array.isArray(res.data), 'Resposta deve ser um array de planos');
    assert(res.data.length >= 2, 'Deve conter ao menos 2 planos (freemium e premium)');

    const freemium = res.data.find((p) => p.name === 'freemium');
    const premium = res.data.find((p) => p.name === 'premium');
    assert(freemium && freemium.maxUsers === 3, 'Plano freemium deve ter maxUsers = 3');
    assert(premium && premium.maxUsers === null, 'Plano premium deve ter maxUsers = null (ilimitado)');
  });

  await runner.step('1.2. Consulta plano individual (/plans/freemium)', async () => {
    const res = await apiRequest('/plans/freemium');
    assert(res.status === 200, `Esperava status 200, recebeu ${res.status}`);
    assert(res.data.name === 'freemium', 'Nome do plano deve ser freemium');
    assert(res.data.price === 0, 'Preço do freemium deve ser 0');
  });

  await runner.step('1.3. Rejeita consulta de plano inexistente com 400', async () => {
    const res = await apiRequest('/plans/plano-fantasma-xyz');
    assert(res.status === 400, `Esperava status 400, recebeu ${res.status}`);
    assert(res.data && res.data.message, 'Deve retornar mensagem de erro');
  });

  await runner.step('1.4. Validação de cabeçalhos de segurança (Helmet/SecurityHeaders)', async () => {
    const res = await apiRequest('/plans');
    assert(
      res.headers.get('x-content-type-options') === 'nosniff',
      'X-Content-Type-Options deve ser nosniff'
    );
    assert(
      res.headers.get('x-frame-options') === 'DENY',
      'X-Frame-Options deve ser DENY'
    );
    assert(
      Boolean(res.headers.get('content-security-policy')),
      'Content-Security-Policy deve estar presente'
    );
    assert(
      !res.headers.get('x-powered-by'),
      'X-Powered-By não deve ser exposto'
    );
  });

  await runner.step('1.5. Validação de cabeçalhos do Rate Limiter padrão IETF', async () => {
    const res = await apiRequest('/plans');
    assert(res.headers.has('ratelimit-limit'), 'Deve conter cabeçalho RateLimit-Limit');
    assert(res.headers.has('ratelimit-remaining'), 'Deve conter cabeçalho RateLimit-Remaining');
    assert(res.headers.has('ratelimit-reset'), 'Deve conter cabeçalho RateLimit-Reset');
  });

  await runner.step('1.6. Rota inexistente retorna HTTP 404 padronizado', async () => {
    const res = await apiRequest('/rota-totalmente-inexistente-123');
    assert(res.status === 404, `Esperava status 404, recebeu ${res.status}`);
    assert(res.data.message === 'Rota não encontrada.', 'Mensagem deve ser "Rota não encontrada."');
  });

  await runner.step('1.7. Proteção contra DoS por payload excessivo (> 10kb)', async () => {
    const oversizedBody = { payload: 'x'.repeat(12 * 1024) };
    const res = await apiRequest('/auth/login', {
      method: 'POST',
      body: oversizedBody,
    });
    assert(res.status === 413, `Esperava status 413 (Payload Too Large), recebeu ${res.status}`);
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
