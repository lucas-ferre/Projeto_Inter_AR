const {
  ensureServerRunning,
  stopServerIfSpawned,
  apiRequest,
  assert,
  createTestRunner,
} = require('./test-utils');

const run = async () => {
  await ensureServerRunning();
  const runner = createTestRunner('TESTE 5: CONCORRÊNCIA ATÔMICA, LIMITES DE PLANO E PROTEÇÃO DE ADMINS');

  const runId = `${Date.now()}_${Math.floor(Math.random() * 1000)}`;
  let tenantId = null;
  let admin1Token = null;
  let admin1Id = null;
  let memberId = null;

  await runner.step('5.1. Setup: Cria tenant Freemium (limite 3 usuários) e 1º Admin', async () => {
    const tRes = await apiRequest('/tenants', {
      method: 'POST',
      body: { name: `Concorrencia Corp ${runId}`, plan: 'freemium' },
    });
    assert(tRes.status === 201, `Falha ao criar tenant: ${tRes.status}`);
    tenantId = tRes.data._id;

    const aRes = await apiRequest('/auth/register', {
      method: 'POST',
      body: {
        name: 'Admin Concorrencia 1',
        email: `admin1.${runId}@empresa.com`,
        password: 'Password123',
        tenantId,
        registrationToken: tRes.data.registrationToken,
      },
    });
    assert(aRes.status === 201, `Falha ao registrar admin: ${aRes.status}`);
    admin1Id = aRes.data._id;

    const lRes = await apiRequest('/auth/login', {
      method: 'POST',
      body: { email: `admin1.${runId}@empresa.com`, password: 'Password123' },
    });
    assert(lRes.status === 200, `Falha ao logar admin: ${lRes.status}`);
    admin1Token = lRes.data.token;
  });

  await runner.step('5.2. Dispara 5 criações SIMULTÂNEAS de membros -> Exatamente 2 vagas restantes preenchidas', async () => {
    // Tenant já tem 1 admin. O plano freemium permite no máximo 3 usuários.
    // 5 requisições paralelas devem resultar em: 2 criados (201) e 3 bloqueados (403).
    const parallelRequests = Array.from({ length: 5 }, (_, idx) =>
      apiRequest('/users', {
        method: 'POST',
        token: admin1Token,
        body: {
          name: `Membro Paralelo ${idx}`,
          email: `membro.paralelo.${idx}.${runId}@empresa.com`,
          password: 'Password123',
        },
      })
    );

    const results = await Promise.all(parallelRequests);
    const created = results.filter((r) => r.status === 201);
    const blocked = results.filter((r) => r.status === 403);

    assert(
      created.length === 2,
      `Esperava exatamente 2 criações com sucesso no plano freemium, obteve ${created.length}`
    );
    assert(
      blocked.length === 3,
      `Esperava exatamente 3 requisições barradas com 403, obteve ${blocked.length}`
    );

    memberId = created[0].data._id;

    // Confirma total no endpoint de listagem
    const listRes = await apiRequest('/users', { token: admin1Token });
    assert(listRes.status === 200, 'Falha ao listar usuários');
    assert(listRes.data.length === 3, `Esperava exatamente 3 usuários no tenant, encontrou ${listRes.data.length}`);
  });

  await runner.step('5.3. Dispara 4 promoções SIMULTÂNEAS do mesmo membro -> adminCount não sofre inflação', async () => {
    // Promove o mesmo membro 4 vezes em paralelo
    const parallelPromos = Array.from({ length: 4 }, () =>
      apiRequest(`/users/${memberId}`, {
        method: 'PATCH',
        token: admin1Token,
        body: { role: 'admin' },
      })
    );

    const promoResults = await Promise.all(parallelPromos);
    const validStatuses = promoResults.every((r) => r.status === 200 || r.status === 409);
    assert(validStatuses, 'Todas as respostas devem ser 200 (sucesso/idempotente) ou 409 (conflito)');
    assert(
      promoResults.some((r) => r.status === 200),
      'Ao menos 1 requisição deve concluir com sucesso'
    );
  });

  await runner.step('5.4. Admin 1 e Admin 2 tentam exclusão mútua SIMULTÂNEA -> Apenas 1 é excluído e último admin é protegido', async () => {
    // Loga com o Admin 2 (membro recém-promovido)
    const listRes = await apiRequest('/users', { token: admin1Token });
    const admin2User = listRes.data.find((u) => u._id === memberId);
    assert(admin2User && admin2User.role === 'admin', 'Membro deve ter sido promovido a admin');

    const l2Res = await apiRequest('/auth/login', {
      method: 'POST',
      body: { email: admin2User.email, password: 'Password123' },
    });
    assert(l2Res.status === 200, 'Falha no login do Admin 2');
    const admin2Token = l2Res.data.token;

    // Admin 1 tenta excluir Admin 2 E Admin 2 tenta excluir Admin 1 ao mesmo tempo
    const mutualDeletions = await Promise.all([
      apiRequest(`/users/${memberId}`, { method: 'DELETE', token: admin1Token }),
      apiRequest(`/users/${admin1Id}`, { method: 'DELETE', token: admin2Token }),
    ]);

    const succeeded = mutualDeletions.filter((r) => r.status === 200);
    const blockedLastAdmin = mutualDeletions.filter((r) => r.status === 400);

    assert(
      succeeded.length === 1,
      `Esperava exatamente 1 exclusão bem-sucedida, obteve ${succeeded.length}`
    );
    assert(
      blockedLastAdmin.length === 1,
      `A exclusão concorrente do último admin deve ser bloqueada com 400, obteve ${blockedLastAdmin.length}`
    );

    // Verifica que restou exatamente 1 administrador ativo no tenant
    const survivorToken = succeeded[0] === mutualDeletions[0] ? admin1Token : admin2Token;
    const finalUsers = await apiRequest('/users', { token: survivorToken });
    const remainingAdmins = finalUsers.data.filter((u) => u.role === 'admin');
    assert(
      remainingAdmins.length === 1,
      `Deve restar exatamente 1 administrador ativo no tenant, encontrou ${remainingAdmins.length}`
    );
  });

  await runner.step('5.5. Limpeza: remoção do tenant de teste', async () => {
    if (tenantId) {
      // Como não sabemos qual admin sobreviveu, tenta login com admin1
      let cleanToken = admin1Token;
      const testLogin = await apiRequest('/auth/login', {
        method: 'POST',
        body: { email: `admin1.${runId}@empresa.com`, password: 'Password123' },
      });
      if (testLogin.status === 200) {
        cleanToken = testLogin.data.token;
      }
      await apiRequest(`/tenants/${tenantId}`, { method: 'DELETE', token: cleanToken });
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
