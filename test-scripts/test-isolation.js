const {
  ensureServerRunning,
  stopServerIfSpawned,
  apiRequest,
  assert,
  createTestRunner,
} = require('./test-utils');

const run = async () => {
  await ensureServerRunning();
  const runner = createTestRunner('TESTE 4: ISOLAMENTO MULTITENANT & SEGURANÇA CROSS-TENANT');

  const runId = `${Date.now()}_${Math.floor(Math.random() * 1000)}`;
  let tenantAId = null;
  let tenantBId = null;
  let tokenA = null;
  let tokenB = null;
  let userBId = null;

  await runner.step('4.1. Setup: Cria Tenant A e Tenant B com seus respectivos administradores', async () => {
    const tA = await apiRequest('/tenants', {
      method: 'POST',
      body: { name: `Alpha Corp ${runId}`, plan: 'freemium' },
    });
    const tB = await apiRequest('/tenants', {
      method: 'POST',
      body: { name: `Beta Corp ${runId}`, plan: 'freemium' },
    });
    assert(tA.status === 201 && tB.status === 201, 'Falha ao criar tenants A e B');
    tenantAId = tA.data._id;
    tenantBId = tB.data._id;

    await apiRequest('/auth/register', {
      method: 'POST',
      body: {
        name: 'Admin Alpha',
        email: `admin.a.${runId}@alpha.com`,
        password: 'Password123',
        tenantId: tenantAId,
        registrationToken: tA.data.registrationToken,
      },
    });

    await apiRequest('/auth/register', {
      method: 'POST',
      body: {
        name: 'Admin Beta',
        email: `admin.b.${runId}@beta.com`,
        password: 'Password123',
        tenantId: tenantBId,
        registrationToken: tB.data.registrationToken,
      },
    });

    const lA = await apiRequest('/auth/login', {
      method: 'POST',
      body: { email: `admin.a.${runId}@alpha.com`, password: 'Password123' },
    });
    const lB = await apiRequest('/auth/login', {
      method: 'POST',
      body: { email: `admin.b.${runId}@beta.com`, password: 'Password123' },
    });
    assert(lA.status === 200 && lB.status === 200, 'Falha ao logar admins A e B');
    tokenA = lA.data.token;
    tokenB = lB.data.token;

    // Cria um membro dentro do Tenant B
    const mB = await apiRequest('/users', {
      method: 'POST',
      token: tokenB,
      body: {
        name: 'Membro Beta',
        email: `membro.b.${runId}@beta.com`,
        password: 'Password123',
      },
    });
    assert(mB.status === 201, 'Falha ao criar membro em Beta');
    userBId = mB.data._id;
  });

  await runner.step('4.2. Admin A tenta ler dados do Tenant B (GET /tenants/:idB) -> Bloqueado com 403', async () => {
    const res = await apiRequest(`/tenants/${tenantBId}`, { token: tokenA });
    assert(res.status === 403, `Esperava 403, recebeu ${res.status}`);
  });

  await runner.step('4.3. Admin A tenta atualizar o Tenant B (PATCH /tenants/:idB) -> Bloqueado com 403', async () => {
    const res = await apiRequest(`/tenants/${tenantBId}`, {
      method: 'PATCH',
      token: tokenA,
      body: { name: 'Invasão Hacker' },
    });
    assert(res.status === 403, `Esperava 403, recebeu ${res.status}`);
  });

  await runner.step('4.4. Admin A tenta excluir o Tenant B (DELETE /tenants/:idB) -> Bloqueado com 403', async () => {
    const res = await apiRequest(`/tenants/${tenantBId}`, {
      method: 'DELETE',
      token: tokenA,
    });
    assert(res.status === 403, `Esperava 403, recebeu ${res.status}`);
  });

  await runner.step('4.5. Admin A tenta listar usuários do Tenant B (/tenants/:idB/users) -> Bloqueado com 403', async () => {
    const res = await apiRequest(`/tenants/${tenantBId}/users`, { token: tokenA });
    assert(res.status === 403, `Esperava 403, recebeu ${res.status}`);
  });

  await runner.step('4.6. Admin A tenta consultar usuário de Tenant B (GET /users/:idB) -> Não encontrado (404)', async () => {
    const res = await apiRequest(`/users/${userBId}`, { token: tokenA });
    assert(res.status === 404, `Esperava 404, recebeu ${res.status}`);
  });

  await runner.step('4.7. Admin A tenta excluir usuário de Tenant B (DELETE /users/:idB) -> Não encontrado (404)', async () => {
    const res = await apiRequest(`/users/${userBId}`, {
      method: 'DELETE',
      token: tokenA,
    });
    assert(res.status === 404, `Esperava 404, recebeu ${res.status}`);
  });

  await runner.step('4.8. Listagem de usuários do Admin A retorna estritamente os usuários do Tenant A', async () => {
    const res = await apiRequest('/users', { token: tokenA });
    assert(res.status === 200, `Esperava 200, recebeu ${res.status}`);
    assert(Array.isArray(res.data), 'Resposta deve ser array');
    assert(res.data.length === 1, 'Admin A deve ver apenas 1 usuário');
    assert(res.data[0].tenantId === tenantAId, 'Usuário listado deve pertencer ao Tenant A');
  });

  await runner.step('4.9. Mesma pessoa se cadastra em Tenant A e Tenant B com o mesmo e-mail (unicidade por tenant)', async () => {
    const sharedEmail = `consultora.${runId}@exemplo.com`;

    const uA = await apiRequest('/users', {
      method: 'POST',
      token: tokenA,
      body: {
        name: 'Maria em Alpha',
        email: sharedEmail,
        password: 'Password123',
      },
    });
    const uB = await apiRequest('/users', {
      method: 'POST',
      token: tokenB,
      body: {
        name: 'Maria em Beta',
        email: sharedEmail,
        password: 'Password123',
      },
    });
    assert(uA.status === 201, `Esperava 201 no cadastro em Alpha, recebeu ${uA.status}`);
    assert(uB.status === 201, `Esperava 201 no cadastro em Beta, recebeu ${uB.status}`);

    // Tentativa de login sem tenantId quando há duplicidade -> 409 solicitando tenantId
    const loginAmbiguo = await apiRequest('/auth/login', {
      method: 'POST',
      body: { email: sharedEmail, password: 'Password123' },
    });
    assert(loginAmbiguo.status === 409, `Esperava 409 no login ambíguo, recebeu ${loginAmbiguo.status}`);
    assert(
      /múltiplos tenants/i.test(loginAmbiguo.data?.message || ''),
      `Mensagem esperada. Recebeu: ${loginAmbiguo.data?.message}`
    );

    // Login especificando tenantId funciona com precisão
    const loginAlpha = await apiRequest('/auth/login', {
      method: 'POST',
      body: { email: sharedEmail, password: 'Password123', tenantId: tenantAId },
    });
    assert(loginAlpha.status === 200, `Esperava 200 com tenantId especificado, recebeu ${loginAlpha.status}`);
    assert(loginAlpha.data.user.tenantId === tenantAId, 'Deve logar especificamente no tenant especificado');
  });

  await runner.step('4.10. Limpeza: remoção dos tenants A e B criados para o teste', async () => {
    if (tenantAId && tokenA) {
      await apiRequest(`/tenants/${tenantAId}`, { method: 'DELETE', token: tokenA });
    }
    if (tenantBId && tokenB) {
      await apiRequest(`/tenants/${tenantBId}`, { method: 'DELETE', token: tokenB });
    }
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
