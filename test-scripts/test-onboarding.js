const {
  ensureServerRunning,
  stopServerIfSpawned,
  apiRequest,
  assert,
  createTestRunner,
} = require('./test-utils');

const run = async () => {
  await ensureServerRunning();
  const runner = createTestRunner('TESTE 2: FLUXO DE ONBOARDING & REGISTRATION TOKEN');

  const runId = `${Date.now()}_${Math.floor(Math.random() * 1000)}`;
  let tenantId = null;
  let validToken = null;
  let adminJwtToken = null;

  await runner.step('2.1. Bloqueia criação pública de tenant em plano pago (premium) com 403', async () => {
    const res = await apiRequest('/tenants', {
      method: 'POST',
      body: { name: `Empresa Paga ${runId}`, plan: 'premium' },
    });
    assert(res.status === 403, `Esperava status 403, recebeu ${res.status}`);
    assert(
      /requer ativação de pagamento/i.test(res.data?.message || ''),
      `Mensagem esperada sobre pagamento. Recebeu: ${res.data?.message}`
    );
  });

  await runner.step('2.2. Criação de tenant freemium retorna registrationToken de uso único', async () => {
    const res = await apiRequest('/tenants', {
      method: 'POST',
      body: { name: `Empresa Onboarding ${runId}`, plan: 'freemium' },
    });
    assert(res.status === 201, `Esperava status 201, recebeu ${res.status}`);
    assert(Boolean(res.data._id), 'Resposta deve conter _id do tenant');
    assert(Boolean(res.data.registrationToken), 'Resposta deve conter registrationToken');
    assert(
      /^[a-f\d]{64}$/i.test(res.data.registrationToken),
      'registrationToken deve ser uma string hexadecimal de 64 caracteres'
    );
    assert(
      res.data.registrationTokenHash === undefined,
      'registrationTokenHash NÃO deve ser vazado no JSON da resposta'
    );

    tenantId = res.data._id;
    validToken = res.data.registrationToken;
  });

  await runner.step('2.3. Bloqueia 1º registro de usuário sem registrationToken com 403', async () => {
    const res = await apiRequest('/auth/register', {
      method: 'POST',
      body: {
        name: 'Tentativa Sem Token',
        email: `semtoken.${runId}@empresa.com`,
        password: 'Password123',
        tenantId,
      },
    });
    assert(res.status === 403, `Esperava status 403, recebeu ${res.status}`);
  });

  await runner.step('2.4. Bloqueia registro com token em formato malformado com 400', async () => {
    const res = await apiRequest('/auth/register', {
      method: 'POST',
      body: {
        name: 'Token Malformado',
        email: `malformado.${runId}@empresa.com`,
        password: 'Password123',
        tenantId,
        registrationToken: 'token-invalido-curto',
      },
    });
    assert(res.status === 400, `Esperava status 400, recebeu ${res.status}`);
    assert(
      /código de registro/i.test(res.data?.message || ''),
      `Mensagem de validação de token esperada. Recebeu: ${res.data?.message}`
    );
  });

  await runner.step('2.5. Bloqueia registro com token incorreto com 403', async () => {
    const fakeToken = 'a'.repeat(64);
    const res = await apiRequest('/auth/register', {
      method: 'POST',
      body: {
        name: 'Token Errado',
        email: `errado.${runId}@empresa.com`,
        password: 'Password123',
        tenantId,
        registrationToken: fakeToken,
      },
    });
    assert(res.status === 403, `Esperava status 403, recebeu ${res.status}`);
  });

  await runner.step('2.6. Conclui 1º registro com token válido e atribui papel de admin', async () => {
    const res = await apiRequest('/auth/register', {
      method: 'POST',
      body: {
        name: 'Administrador Oficial',
        email: `admin.${runId}@empresa.com`,
        password: 'Password123',
        tenantId,
        registrationToken: validToken,
      },
    });
    assert(res.status === 201, `Esperava status 201, recebeu ${res.status}`);
    assert(res.data.role === 'admin', 'Primeiro usuário deve ter role: admin');
    assert(Boolean(res.data._id), 'Usuário criado deve conter _id');
    assert(res.data.password === undefined, 'Senha não deve ser retornada no JSON');
  });

  await runner.step('2.7. Bloqueia reuso do registrationToken em novo cadastro público com 403', async () => {
    const res = await apiRequest('/auth/register', {
      method: 'POST',
      body: {
        name: 'Intruso Reuso Token',
        email: `intruso.${runId}@empresa.com`,
        password: 'Password123',
        tenantId,
        registrationToken: validToken,
      },
    });
    assert(res.status === 403, `Esperava status 403, recebeu ${res.status}`);
  });

  await runner.step('2.8. Login do admin recém-criado gera JWT válido com role: admin', async () => {
    const res = await apiRequest('/auth/login', {
      method: 'POST',
      body: {
        email: `admin.${runId}@empresa.com`,
        password: 'Password123',
      },
    });
    assert(res.status === 200, `Esperava status 200, recebeu ${res.status}`);
    assert(Boolean(res.data.token), 'Login deve retornar token JWT');
    assert(res.data.user.role === 'admin', 'User no login deve ter role admin');
    adminJwtToken = res.data.token;
  });

  await runner.step('2.9. Limpeza: remoção do tenant de teste criado', async () => {
    if (tenantId && adminJwtToken) {
      const res = await apiRequest(`/tenants/${tenantId}`, {
        method: 'DELETE',
        token: adminJwtToken,
      });
      assert(res.status === 200, `Esperava status 200 na remoção, recebeu ${res.status}`);
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
