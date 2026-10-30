const {
  ensureServerRunning,
  stopServerIfSpawned,
  apiRequest,
  assert,
  createTestRunner,
} = require('./test-utils');

const run = async () => {
  await ensureServerRunning();
  const runner = createTestRunner('TESTE 3: CONTROLE DE ACESSO BASEADO EM PAPÉIS (RBAC)');

  const runId = `${Date.now()}_${Math.floor(Math.random() * 1000)}`;
  let tenantId = null;
  let adminId = null;
  let adminToken = null;
  let memberId = null;
  let memberToken = null;

  await runner.step('3.1. Setup: Cria tenant e registra administrador inicial', async () => {
    const tRes = await apiRequest('/tenants', {
      method: 'POST',
      body: { name: `RBAC Corp ${runId}`, plan: 'freemium' },
    });
    assert(tRes.status === 201, `Falha ao criar tenant: ${tRes.status}`);
    tenantId = tRes.data._id;
    const regToken = tRes.data.registrationToken;

    const aRes = await apiRequest('/auth/register', {
      method: 'POST',
      body: {
        name: 'Admin RBAC',
        email: `admin.rbac.${runId}@empresa.com`,
        password: 'Password123',
        tenantId,
        registrationToken: regToken,
      },
    });
    assert(aRes.status === 201, `Falha ao registrar admin: ${aRes.status}`);
    adminId = aRes.data._id;

    const lRes = await apiRequest('/auth/login', {
      method: 'POST',
      body: { email: `admin.rbac.${runId}@empresa.com`, password: 'Password123' },
    });
    assert(lRes.status === 200, `Falha no login do admin: ${lRes.status}`);
    adminToken = lRes.data.token;
  });

  await runner.step('3.2. Admin adiciona um novo usuário comum (role: member)', async () => {
    const res = await apiRequest('/users', {
      method: 'POST',
      token: adminToken,
      body: {
        name: 'Membro Teste',
        email: `membro.${runId}@empresa.com`,
        password: 'Password123',
        role: 'member',
      },
    });
    assert(res.status === 201, `Esperava status 201, recebeu ${res.status}`);
    assert(res.data.role === 'member', 'Usuário criado deve ter role member');
    memberId = res.data._id;

    const lRes = await apiRequest('/auth/login', {
      method: 'POST',
      body: { email: `membro.${runId}@empresa.com`, password: 'Password123' },
    });
    assert(lRes.status === 200, 'Login do membro deve retornar 200');
    assert(lRes.data.user.role === 'member', 'Role do usuário deve ser member');
    memberToken = lRes.data.token;
  });

  await runner.step('3.3. Membro tenta criar outro usuário (POST /users) -> Bloqueado com 403', async () => {
    const res = await apiRequest('/users', {
      method: 'POST',
      token: memberToken,
      body: {
        name: 'Usuário Ilegal',
        email: `ilegal.${runId}@empresa.com`,
        password: 'Password123',
      },
    });
    assert(res.status === 403, `Esperava status 403, recebeu ${res.status}`);
  });

  await runner.step('3.4. Membro tenta excluir o tenant (DELETE /tenants/:id) -> Bloqueado com 403', async () => {
    const res = await apiRequest(`/tenants/${tenantId}`, {
      method: 'DELETE',
      token: memberToken,
    });
    assert(res.status === 403, `Esperava status 403, recebeu ${res.status}`);
  });

  await runner.step('3.5. Membro tenta atualizar dados do tenant (PUT/PATCH) -> Bloqueado com 403', async () => {
    const res = await apiRequest(`/tenants/${tenantId}`, {
      method: 'PATCH',
      token: memberToken,
      body: { name: 'Tentativa Hacker' },
    });
    assert(res.status === 403, `Esperava status 403, recebeu ${res.status}`);
  });

  await runner.step('3.6. Membro tenta se autopromover para admin -> Bloqueado com 403', async () => {
    const res = await apiRequest(`/users/${memberId}`, {
      method: 'PATCH',
      token: memberToken,
      body: { role: 'admin' },
    });
    assert(res.status === 403, `Esperava status 403, recebeu ${res.status}`);
  });

  await runner.step('3.7. Membro tenta excluir o administrador -> Bloqueado com 403', async () => {
    const res = await apiRequest(`/users/${adminId}`, {
      method: 'DELETE',
      token: memberToken,
    });
    assert(res.status === 403, `Esperava status 403, recebeu ${res.status}`);
  });

  await runner.step('3.8. Membro atualiza seus próprios dados cadastrais (nome) -> Sucesso 200', async () => {
    const res = await apiRequest(`/users/${memberId}`, {
      method: 'PATCH',
      token: memberToken,
      body: { name: 'Membro Atualizado com Sucesso' },
    });
    assert(res.status === 200, `Esperava status 200, recebeu ${res.status}`);
    assert(res.data.name === 'Membro Atualizado com Sucesso', 'Nome deve ser atualizado');
  });

  await runner.step('3.9. Admin tenta autoexclusão da própria conta -> Bloqueado com 400', async () => {
    const res = await apiRequest(`/users/${adminId}`, {
      method: 'DELETE',
      token: adminToken,
    });
    assert(res.status === 400, `Esperava status 400, recebeu ${res.status}`);
    assert(
      /não pode remover a sua própria conta/i.test(res.data?.message || ''),
      `Mensagem esperada. Recebeu: ${res.data?.message}`
    );
  });

  await runner.step('3.10. Admin tenta se autorebaixar para member sendo o único admin -> Bloqueado com 400', async () => {
    const res = await apiRequest(`/users/${adminId}`, {
      method: 'PATCH',
      token: adminToken,
      body: { role: 'member' },
    });
    assert(res.status === 400, `Esperava status 400, recebeu ${res.status}`);
    assert(
      /único administrador/i.test(res.data?.message || ''),
      `Mensagem esperada. Recebeu: ${res.data?.message}`
    );
  });

  await runner.step('3.11. Admin remove o usuário membro e token do membro é revogado imediatamente (401)', async () => {
    const delRes = await apiRequest(`/users/${memberId}`, {
      method: 'DELETE',
      token: adminToken,
    });
    assert(delRes.status === 200, `Esperava status 200 na remoção do membro, recebeu ${delRes.status}`);

    // Tentativa imediata com o JWT do membro excluído
    const checkRes = await apiRequest('/users', {
      token: memberToken,
    });
    assert(
      checkRes.status === 401,
      `Esperava 401 após exclusão do membro (revogação de sessão), recebeu ${checkRes.status}`
    );
  });

  await runner.step('3.12. Limpeza: remoção do tenant de teste', async () => {
    if (tenantId && adminToken) {
      const res = await apiRequest(`/tenants/${tenantId}`, {
        method: 'DELETE',
        token: adminToken,
      });
      assert(res.status === 200, `Esperava status 200, recebeu ${res.status}`);
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
