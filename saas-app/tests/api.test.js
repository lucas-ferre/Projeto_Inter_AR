const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');

process.env.JWT_SECRET = 'test_secret_key_with_more_than_32_characters_for_hs256_signing';
process.env.ALLOW_PUBLIC_MULTI_REGISTER = 'false';
process.env.ALLOW_DIRECT_PLAN_CHANGE = 'false';
process.env.RATE_LIMIT_STORE = 'mongodb';

const TEST_DB_URI = `mongodb://localhost:27017/saas_test_suite_${process.pid}`;
process.env.MONGO_URI = TEST_DB_URI;

const app = require('../server');
const { mongoose, connectDatabase } = require('../config/db');
const Plan = require('../models/Plan');
const Tenant = require('../models/Tenant');
const User = require('../models/User');
const RateLimitBucket = require('../models/RateLimitBucket');
const { reconcilePendingTenantDeletions } = require('../services/tenantService');
const { createRateLimiter } = require('../middleware/rateLimiter');
const { sanitizeSensitiveText } = require('../middleware/errorHandler');
const { isValidEmail, validatePasswordRules } = require('../middleware/validateRequest');

let server;
let baseUrl;

const apiRequest = async (path, { method = 'GET', token, rawAuthHeader, body } = {}) => {
  const headers = {};
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
  }
  if (rawAuthHeader !== undefined) {
    headers.Authorization = rawAuthHeader;
  } else if (token) {
    headers.Authorization = `Bearer ${token}`;
  }

  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

  const data = response.status === 204 ? null : await response.json();
  return { status: response.status, headers: response.headers, data };
};

describe('SaaS App — Auditoria & Suíte de Integração Completa', () => {
  before(async () => {
    await connectDatabase(TEST_DB_URI);
    await mongoose.connection.db.dropDatabase();
    await mongoose.syncIndexes();
    const { seedDefaultPlans } = require('../services/planService');
    await seedDefaultPlans();

    await new Promise((resolve) => {
      server = app.listen(0, '127.0.0.1', () => {
        const { port } = server.address();
        baseUrl = `http://127.0.0.1:${port}`;
        resolve();
      });
    });
  });

  after(async () => {
    if (server) {
      await new Promise((resolve) => server.close(resolve));
    }
    if (mongoose.connection.readyState === 1) {
      await mongoose.connection.db.dropDatabase();
      await mongoose.connection.close();
    }
  });

  it('1. Utilitários de segurança: sanitiza MONGO_URI com "@" na senha, bloqueia ReDoS e senhas inválidas', () => {
    const leakedInput = 'Falha em mongodb://admin:secr@tPass123@cluster0.mongodb.net/saas';
    const sanitized = sanitizeSensitiveText(leakedInput);
    assert.equal(sanitized, 'Falha em mongodb://***:***@cluster0.mongodb.net/saas');
    assert.ok(!sanitized.includes('tPass123'));

    assert.equal(isValidEmail('a@...'), false);
    assert.equal(isValidEmail('a@b..c'), false);
    assert.equal(isValidEmail('admin@empresa.com.br'), true);

    const t0 = performance.now();
    const malicious = 'a@' + '.'.repeat(9500) + '@';
    assert.equal(isValidEmail(malicious), false);
    const elapsed = performance.now() - t0;
    assert.ok(elapsed < 10, `Validação de e-mail demorou ${elapsed}ms`);

    assert.ok(validatePasswordRules('     a') !== null, 'Deve rejeitar senha preenchida com espaços');
    assert.ok(validatePasswordRules('a'.repeat(73)) !== null, 'Deve rejeitar senha > 72 bytes');
    assert.equal(validatePasswordRules('SenhaForte123'), null);
  });

  it('2. Integração do model Plan no MongoDB (seed automático e validação dinâmica)', async () => {
    const res = await apiRequest('/plans');
    assert.equal(res.status, 200);
    assert.equal(res.data.length, 2);

    const freemium = res.data.find((p) => p.name === 'freemium');
    const premium = res.data.find((p) => p.name === 'premium');
    assert.equal(freemium.maxUsers, 3);
    assert.equal(premium.maxUsers, null);

    const invalidTenant = await apiRequest('/tenants', {
      method: 'POST',
      body: { name: 'Empresa Plano Inválido', plan: 'inexistente' },
    });
    assert.equal(invalidTenant.status, 400);

    const countPlansInDb = await Plan.countDocuments();
    assert.equal(countPlansInDb, 2);
  });

  it('3. Unicidade case-insensitive de Tenant e bloqueio de corrida (TOCTOU) no registro público', async () => {
    const t1 = await apiRequest('/tenants', {
      method: 'POST',
      body: { name: 'Empresa Alpha', plan: 'freemium' },
    });
    assert.equal(t1.status, 201);
    assert.ok(t1.data._id);
    assert.equal(t1.data.userCount, undefined);
    assert.equal(t1.data.status, undefined);

    const duplicateCase = await apiRequest('/tenants', {
      method: 'POST',
      body: { name: 'empresa alpha', plan: 'freemium' },
    });
    assert.equal(duplicateCase.status, 409);

    const parallelRegisters = await Promise.all(
      Array.from({ length: 5 }, (_, idx) =>
        apiRequest('/auth/register', {
          method: 'POST',
          body: {
            name: `Candidato ${idx}`,
            email: `candidato${idx}@alpha.com`,
            password: 'Password123',
            tenantId: t1.data._id,
          },
        })
      )
    );

    const created = parallelRegisters.filter((r) => r.status === 201);
    const blocked = parallelRegisters.filter((r) => r.status === 403);
    assert.equal(created.length, 1, 'Exatamente 1 registro inicial deve vencer a corrida');
    assert.equal(blocked.length, 4, 'Os outros 4 registros concorrentes devem receber 403');
    assert.equal(created[0].data.role, 'admin');
    assert.ok(created[0].data._id);
    assert.equal(created[0].data.id, undefined);
    assert.equal(created[0].data.password, undefined);
  });

  it('4. RBAC completo, padronização _id, proteção de plano, concorrência freemium e revogação imediata de JWT', async () => {
    const tenantRes = await apiRequest('/tenants', {
      method: 'POST',
      body: { name: 'Tech Corp', plan: 'freemium' },
    });
    assert.equal(tenantRes.status, 201);
    const tenantId = tenantRes.data._id;

    const adminReg = await apiRequest('/auth/register', {
      method: 'POST',
      body: {
        name: 'Admin Tech',
        email: 'admin@techcorp.com',
        password: 'Password123',
        tenantId,
      },
    });
    assert.equal(adminReg.status, 201);
    const adminId = adminReg.data._id;

    const adminLogin = await apiRequest('/auth/login', {
      method: 'POST',
      body: { email: 'admin@techcorp.com', password: 'Password123' },
    });
    assert.equal(adminLogin.status, 200);
    assert.equal(adminLogin.data.user._id, adminId);
    assert.equal(adminLogin.data.user.role, 'admin');
    const adminToken = adminLogin.data.token;

    const lowerBearerRes = await apiRequest(`/tenants/${tenantId}`, {
      rawAuthHeader: `bearer   ${adminToken}`,
    });
    assert.equal(lowerBearerRes.status, 200);

    const concurrentUsers = await Promise.all(
      Array.from({ length: 6 }, (_, idx) =>
        apiRequest('/users', {
          method: 'POST',
          token: adminToken,
          body: {
            name: `Membro ${idx}`,
            email: `membro${idx}@techcorp.com`,
            password: 'Password123',
          },
        })
      )
    );

    const succeededMembers = concurrentUsers.filter((r) => r.status === 201);
    const rejectedMembers = concurrentUsers.filter((r) => r.status === 403);
    assert.equal(succeededMembers.length, 2, 'Apenas 2 vagas restantes podem ser preenchidas');
    assert.equal(rejectedMembers.length, 4, 'As outras 4 requisições paralelas devem receber 403');

    const totalInDb = await User.countDocuments({ tenantId });
    assert.equal(totalInDb, 3);

    const memberUser = succeededMembers[0].data;
    assert.equal(memberUser.role, 'member');
    assert.ok(memberUser._id);

    const memberLogin = await apiRequest('/auth/login', {
      method: 'POST',
      body: { email: memberUser.email, password: 'Password123' },
    });
    assert.equal(memberLogin.status, 200);
    const memberToken = memberLogin.data.token;

    const listAsMember = await apiRequest('/users', { token: memberToken });
    assert.equal(listAsMember.status, 200);
    assert.equal(listAsMember.data.length, 3);
    assert.equal(listAsMember.headers.get('x-total-count'), '3');

    const selfUpdate = await apiRequest(`/users/${memberUser._id}`, {
      method: 'PATCH',
      token: memberToken,
      body: { name: 'Membro Atualizado' },
    });
    assert.equal(selfUpdate.status, 200);
    assert.equal(selfUpdate.data.name, 'Membro Atualizado');

    const roleEscalation = await apiRequest(`/users/${memberUser._id}`, {
      method: 'PATCH',
      token: memberToken,
      body: { role: 'admin' },
    });
    assert.equal(roleEscalation.status, 403);

    const deleteAdminByMember = await apiRequest(`/users/${adminId}`, {
      method: 'DELETE',
      token: memberToken,
    });
    assert.equal(deleteAdminByMember.status, 403);

    const deleteTenantByMember = await apiRequest(`/tenants/${tenantId}`, {
      method: 'DELETE',
      token: memberToken,
    });
    assert.equal(deleteTenantByMember.status, 403);

    const adminSelfDelete = await apiRequest(`/users/${adminId}`, {
      method: 'DELETE',
      token: adminToken,
    });
    assert.equal(adminSelfDelete.status, 400);

    const adminSelfDemote = await apiRequest(`/users/${adminId}`, {
      method: 'PATCH',
      token: adminToken,
      body: { role: 'member' },
    });
    assert.equal(adminSelfDemote.status, 400);

    const freeUpgradeAttempt = await apiRequest(`/tenants/${tenantId}`, {
      method: 'PUT',
      token: adminToken,
      body: { name: 'Tech Corp Pro', plan: 'premium' },
    });
    assert.equal(freeUpgradeAttempt.status, 403);

    const renameTenant = await apiRequest(`/tenants/${tenantId}`, {
      method: 'PATCH',
      token: adminToken,
      body: { name: 'Tech Corp Oficial' },
    });
    assert.equal(renameTenant.status, 200);
    assert.equal(renameTenant.data.name, 'Tech Corp Oficial');

    process.env.ALLOW_DIRECT_PLAN_CHANGE = 'true';
    try {
      const upgradeOk = await apiRequest(`/tenants/${tenantId}`, {
        method: 'PATCH',
        token: adminToken,
        body: { plan: 'premium' },
      });
      assert.equal(upgradeOk.status, 200);

      const fourthUser = await apiRequest('/users', {
        method: 'POST',
        token: adminToken,
        body: {
          name: 'Quarto Usuário',
          email: 'quarto@techcorp.com',
          password: 'Password123',
        },
      });
      assert.equal(fourthUser.status, 201);

      const invalidDowngrade = await apiRequest(`/tenants/${tenantId}`, {
        method: 'PATCH',
        token: adminToken,
        body: { plan: 'freemium' },
      });
      assert.equal(invalidDowngrade.status, 409);
    } finally {
      process.env.ALLOW_DIRECT_PLAN_CHANGE = 'false';
    }

    const deleteMemberRes = await apiRequest(`/users/${memberUser._id}`, {
      method: 'DELETE',
      token: adminToken,
    });
    assert.equal(deleteMemberRes.status, 200);

    const deletedMemberAccess = await apiRequest('/users', { token: memberToken });
    assert.equal(deletedMemberAccess.status, 401);

    const deleteTenantRes = await apiRequest(`/tenants/${tenantId}`, {
      method: 'DELETE',
      token: adminToken,
    });
    assert.equal(deleteTenantRes.status, 200);

    const deletedAdminAccess = await apiRequest('/users', { token: adminToken });
    assert.equal(deletedAdminAccess.status, 401);

    const remainingUsers = await User.countDocuments({ tenantId });
    assert.equal(remainingUsers, 0);
  });

  it('5. Isolamento estrito entre Tenants (Tenant A não consegue ler, editar ou excluir recursos do Tenant B)', async () => {
    const tenantARes = await apiRequest('/tenants', {
      method: 'POST',
      body: { name: 'Isolamento Tenant A', plan: 'freemium' },
    });
    const tenantBRes = await apiRequest('/tenants', {
      method: 'POST',
      body: { name: 'Isolamento Tenant B', plan: 'freemium' },
    });
    assert.equal(tenantARes.status, 201);
    assert.equal(tenantBRes.status, 201);

    const tenantAId = tenantARes.data._id;
    const tenantBId = tenantBRes.data._id;

    const adminAReg = await apiRequest('/auth/register', {
      method: 'POST',
      body: {
        name: 'Admin A',
        email: 'admin@tenanta.com',
        password: 'Password123',
        tenantId: tenantAId,
      },
    });
    const adminBReg = await apiRequest('/auth/register', {
      method: 'POST',
      body: {
        name: 'Admin B',
        email: 'admin@tenantb.com',
        password: 'Password123',
        tenantId: tenantBId,
      },
    });
    assert.equal(adminAReg.status, 201);
    assert.equal(adminBReg.status, 201);
    const adminBId = adminBReg.data._id;

    const loginA = await apiRequest('/auth/login', {
      method: 'POST',
      body: { email: 'admin@tenanta.com', password: 'Password123' },
    });
    const loginB = await apiRequest('/auth/login', {
      method: 'POST',
      body: { email: 'admin@tenantb.com', password: 'Password123' },
    });
    const tokenA = loginA.data.token;
    const tokenB = loginB.data.token;

    // Cria membro no Tenant B para tentar acesso cruzado
    const memberBRes = await apiRequest('/users', {
      method: 'POST',
      token: tokenB,
      body: {
        name: 'Membro B',
        email: 'membro@tenantb.com',
        password: 'Password123',
      },
    });
    assert.equal(memberBRes.status, 201);
    const memberBId = memberBRes.data._id;

    // 5.1. Tentativas de acesso cruzado às rotas de /tenants do Tenant B usando token do Admin A
    const getTenantB = await apiRequest(`/tenants/${tenantBId}`, { token: tokenA });
    assert.equal(getTenantB.status, 403);

    const getTenantBUsers = await apiRequest(`/tenants/${tenantBId}/users`, { token: tokenA });
    assert.equal(getTenantBUsers.status, 403);

    const putTenantB = await apiRequest(`/tenants/${tenantBId}`, {
      method: 'PUT',
      token: tokenA,
      body: { name: 'Tentativa Invasão' },
    });
    assert.equal(putTenantB.status, 403);

    const patchTenantB = await apiRequest(`/tenants/${tenantBId}`, {
      method: 'PATCH',
      token: tokenA,
      body: { name: 'Tentativa Invasão Patch' },
    });
    assert.equal(patchTenantB.status, 403);

    const deleteTenantB = await apiRequest(`/tenants/${tenantBId}`, {
      method: 'DELETE',
      token: tokenA,
    });
    assert.equal(deleteTenantB.status, 403);

    // 5.2. Listagens do Admin A só enxergam dados do próprio Tenant A
    const listTenantsA = await apiRequest('/tenants', { token: tokenA });
    assert.equal(listTenantsA.status, 200);
    assert.equal(listTenantsA.data.length, 1);
    assert.equal(listTenantsA.data[0]._id, tenantAId);

    const listUsersA = await apiRequest('/users', { token: tokenA });
    assert.equal(listUsersA.status, 200);
    assert.equal(listUsersA.data.length, 1);
    assert.equal(listUsersA.data[0].tenantId, tenantAId);

    // 5.3. Tentativas de consulta, edição e remoção de usuários do Tenant B usando token do Admin A
    const getUserB = await apiRequest(`/users/${memberBId}`, { token: tokenA });
    assert.equal(getUserB.status, 404);

    const patchUserB = await apiRequest(`/users/${memberBId}`, {
      method: 'PATCH',
      token: tokenA,
      body: { name: 'Alteração Indevida' },
    });
    assert.equal(patchUserB.status, 404);

    const putAdminB = await apiRequest(`/users/${adminBId}`, {
      method: 'PUT',
      token: tokenA,
      body: { name: 'Alteração Admin B' },
    });
    assert.equal(putAdminB.status, 404);

    const deleteUserB = await apiRequest(`/users/${memberBId}`, {
      method: 'DELETE',
      token: tokenA,
    });
    assert.equal(deleteUserB.status, 404);

    // Confirma integridade intacta do Tenant B no banco
    const intactUsersB = await User.countDocuments({ tenantId: tenantBId });
    assert.equal(intactUsersB, 2);
  });

  it('6. Unicidade de e-mail escopada por Tenant ({ tenantId, email }) e autenticação multitenant', async () => {
    const t1 = await apiRequest('/tenants', {
      method: 'POST',
      body: { name: 'Consultoria Norte', plan: 'freemium' },
    });
    const t2 = await apiRequest('/tenants', {
      method: 'POST',
      body: { name: 'Consultoria Sul', plan: 'freemium' },
    });
    assert.equal(t1.status, 201);
    assert.equal(t2.status, 201);

    const sharedEmail = 'maria.consultora@exemplo.com';

    // Mesma pessoa se cadastra como Admin em dois tenants diferentes usando o mesmo e-mail
    const reg1 = await apiRequest('/auth/register', {
      method: 'POST',
      body: {
        name: 'Maria Norte',
        email: sharedEmail,
        password: 'Password123',
        tenantId: t1.data._id,
      },
    });
    const reg2 = await apiRequest('/auth/register', {
      method: 'POST',
      body: {
        name: 'Maria Sul',
        email: sharedEmail,
        password: 'Password123',
        tenantId: t2.data._id,
      },
    });
    assert.equal(reg1.status, 201);
    assert.equal(reg2.status, 201);

    // Quando possui mesma senha em múltiplos tenants ativos, login sem tenantId solicita desambiguação (409)
    const ambiguousLogin = await apiRequest('/auth/login', {
      method: 'POST',
      body: { email: sharedEmail, password: 'Password123' },
    });
    assert.equal(ambiguousLogin.status, 409);

    // Senha incorreta não revela múltiplos vínculos (retorna 401 genérico)
    const wrongPassLogin = await apiRequest('/auth/login', {
      method: 'POST',
      body: { email: sharedEmail, password: 'WrongPassword99' },
    });
    assert.equal(wrongPassLogin.status, 401);

    // Login informando tenantId autentica exatamente no tenant escolhido
    const loginT1 = await apiRequest('/auth/login', {
      method: 'POST',
      body: { email: sharedEmail, password: 'Password123', tenantId: t1.data._id },
    });
    const loginT2 = await apiRequest('/auth/login', {
      method: 'POST',
      body: { email: sharedEmail, password: 'Password123', tenantId: t2.data._id },
    });
    assert.equal(loginT1.status, 200);
    assert.equal(loginT2.status, 200);
    assert.equal(loginT1.data.user.tenantId, t1.data._id);
    assert.equal(loginT2.data.user.tenantId, t2.data._id);

    // Continua proibindo e-mail duplicado DENTRO do mesmo tenant
    const duplicateSameTenant = await apiRequest('/users', {
      method: 'POST',
      token: loginT1.data.token,
      body: {
        name: 'Maria Duplicada',
        email: sharedEmail,
        password: 'Password123',
      },
    });
    assert.equal(duplicateSameTenant.status, 409);
  });

  it('7. Consistência e reconciliação de exclusão interrompida de Tenant (tombstone status="deleting")', async () => {
    const tRes = await apiRequest('/tenants', {
      method: 'POST',
      body: { name: 'Empresa Recuperacao', plan: 'freemium' },
    });
    assert.equal(tRes.status, 201);
    const tenantId = tRes.data._id;

    await apiRequest('/auth/register', {
      method: 'POST',
      body: {
        name: 'Admin Rec',
        email: 'admin@recuperacao.com',
        password: 'Password123',
        tenantId,
      },
    });

    const loginRes = await apiRequest('/auth/login', {
      method: 'POST',
      body: { email: 'admin@recuperacao.com', password: 'Password123' },
    });
    assert.equal(loginRes.status, 200);
    const token = loginRes.data.token;

    // Simula falha parcial no meio da exclusão: tenant marcado como 'deleting', mas usuário ainda no banco
    await Tenant.updateOne({ _id: tenantId }, { $set: { status: 'deleting' } });

    // Token existente e novo login são bloqueados imediatamente
    const blockedTokenAccess = await apiRequest('/users', { token });
    assert.equal(blockedTokenAccess.status, 401);

    const blockedLogin = await apiRequest('/auth/login', {
      method: 'POST',
      body: { email: 'admin@recuperacao.com', password: 'Password123' },
    });
    assert.equal(blockedLogin.status, 401);

    // Rotina de reconciliação conclui a limpeza dos usuários pendentes e remove o tombstone do tenant
    const summary = await reconcilePendingTenantDeletions();
    assert.ok(summary.cleanedTenants >= 1);
    assert.ok(summary.cleanedOrphanUsers >= 1);

    const remainingTenant = await Tenant.findById(tenantId);
    const remainingUsers = await User.countDocuments({ tenantId });
    assert.equal(remainingTenant, null);
    assert.equal(remainingUsers, 0);
  });

  it('8. Rate Limiter distribuído via MongoDB compartilha contadores entre múltiplas instâncias', async () => {
    // Simula duas instâncias separadas de servidor compartilhando o mesmo store MongoDB
    const limiterInstanceA = createRateLimiter({
      scope: 'distributed-cluster-test',
      windowMs: 60 * 1000,
      maxRequests: 3,
    });
    const limiterInstanceB = createRateLimiter({
      scope: 'distributed-cluster-test',
      windowMs: 60 * 1000,
      maxRequests: 3,
    });

    const invokeMiddleware = (mw, ip) =>
      new Promise((resolve) => {
        const headers = {};
        const req = { ip };
        const res = {
          statusCode: 200,
          setHeader(k, v) {
            headers[k.toLowerCase()] = v;
          },
          status(code) {
            this.statusCode = code;
            return this;
          },
          json(payload) {
            resolve({ allowed: false, statusCode: this.statusCode, headers, payload });
          },
        };
        mw(req, res, () => resolve({ allowed: true, statusCode: 200, headers }));
      });

    const clientIp = '203.0.113.77';

    // 2 requisições na Instância A + 1 requisição na Instância B = 3 (limite máximo atingido)
    const r1 = await invokeMiddleware(limiterInstanceA, clientIp);
    const r2 = await invokeMiddleware(limiterInstanceA, clientIp);
    const r3 = await invokeMiddleware(limiterInstanceB, clientIp);
    assert.equal(r1.allowed, true);
    assert.equal(r2.allowed, true);
    assert.equal(r3.allowed, true);
    assert.equal(r3.headers['ratelimit-remaining'], '0');

    // 4ª requisição chega na Instância B -> bloqueada com 429 pois o contador é compartilhado no MongoDB
    const r4 = await invokeMiddleware(limiterInstanceB, clientIp);
    assert.equal(r4.allowed, false);
    assert.equal(r4.statusCode, 429);
    assert.ok(Number(r4.headers['retry-after']) >= 1);

    const persistedBucket = await RateLimitBucket.findOne({
      key: `distributed-cluster-test:${clientIp}`,
    }).lean();
    assert.ok(persistedBucket);
    assert.equal(persistedBucket.count, 4);
  });
});
