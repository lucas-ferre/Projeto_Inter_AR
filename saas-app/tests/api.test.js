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
const registrationTokens = new Map();

const apiRequest = async (path, { method = 'GET', token, rawAuthHeader, body } = {}) => {
  const hasExplicitRegistrationToken =
    body !== undefined && Object.prototype.hasOwnProperty.call(body, 'registrationToken');
  const requestBody =
    path === '/auth/register' && body !== undefined && !hasExplicitRegistrationToken
      ? {
          ...body,
          registrationToken: registrationTokens.get(String(body.tenantId)),
        }
      : body;
  const headers = {};
  if (requestBody !== undefined) {
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
    body: requestBody !== undefined ? JSON.stringify(requestBody) : undefined,
  });

  const data = response.status === 204 ? null : await response.json();
  if (method === 'POST' && path === '/tenants' && data?.registrationToken) {
    registrationTokens.set(String(data._id), data.registrationToken);
  }
  return { status: response.status, headers: response.headers, data };
};

describe('SaaS App — Auditoria & Suíte de Integração Completa', () => {
  before(async () => {
    await connectDatabase(TEST_DB_URI);
    await mongoose.connection.db.dropDatabase();
    await mongoose.syncIndexes();
    const { bootstrapDatabase } = require('../services/bootstrapService');
    await bootstrapDatabase();

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

  it('1.1. Endpoints de liveness e readiness reportam a saúde da API e do MongoDB', async () => {
    const live = await apiRequest('/health/live');
    assert.equal(live.status, 200);
    assert.deepEqual(live.data, { status: 'ok' });
    assert.equal(live.headers.get('cache-control'), 'no-store');

    const ready = await apiRequest('/health/ready');
    assert.equal(ready.status, 200);
    assert.deepEqual(ready.data, {
      status: 'ready',
      dependencies: { mongodb: 'ok' },
    });
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

  it('9. Onboarding seguro: bloqueia plano pago, valida/apaga registrationToken e recicla tenants abandonados (>24h)', async () => {
    await RateLimitBucket.deleteMany({});

    // 9.1. Criação pública de tenant rejeita planos pagos (price > 0) com 403
    const paidTenantRes = await apiRequest('/tenants', {
      method: 'POST',
      body: { name: 'Empresa Premium Sem Billing', plan: 'premium' },
    });
    assert.equal(paidTenantRes.status, 403);

    // 9.2. Criação em plano gratuito retorna registrationToken de 64 hex chars e armazena apenas hash no banco
    const freeTenantRes = await apiRequest('/tenants', {
      method: 'POST',
      body: { name: 'Empresa Onboarding Seguro', plan: 'freemium' },
    });
    assert.equal(freeTenantRes.status, 201);
    const tenantId = freeTenantRes.data._id;
    const validRegToken = freeTenantRes.data.registrationToken;
    assert.match(validRegToken, /^[a-f\d]{64}$/i);
    assert.equal(freeTenantRes.data.registrationTokenHash, undefined);

    const rawBeforeReg = await Tenant.findById(tenantId)
      .select('+registrationTokenHash +registrationTokenExpiresAt')
      .lean();
    assert.ok(rawBeforeReg.registrationTokenHash);
    assert.notEqual(rawBeforeReg.registrationTokenHash, validRegToken);

    // 9.3. Registro inicial sem token (403), token malformado (400) e token incorreto (403)
    const missingTokenReg = await apiRequest('/auth/register', {
      method: 'POST',
      body: {
        name: 'Sem Token',
        email: 'semtoken@onboarding.com',
        password: 'Password123',
        tenantId,
        registrationToken: undefined,
      },
    });
    assert.equal(missingTokenReg.status, 403);

    const malformedTokenReg = await apiRequest('/auth/register', {
      method: 'POST',
      body: {
        name: 'Token Malformado',
        email: 'malformado@onboarding.com',
        password: 'Password123',
        tenantId,
        registrationToken: 'token-invalido',
      },
    });
    assert.equal(malformedTokenReg.status, 400);

    const wrongTokenReg = await apiRequest('/auth/register', {
      method: 'POST',
      body: {
        name: 'Token Errado',
        email: 'errado@onboarding.com',
        password: 'Password123',
        tenantId,
        registrationToken: '0'.repeat(64),
      },
    });
    assert.equal(wrongTokenReg.status, 403);

    // 9.4. Registro com token válido conclui como admin e remove hash/expiração do banco
    const validReg = await apiRequest('/auth/register', {
      method: 'POST',
      body: {
        name: 'Admin Onboarding',
        email: 'admin@onboarding.com',
        password: 'Password123',
        tenantId,
        registrationToken: validRegToken,
      },
    });
    assert.equal(validReg.status, 201);
    assert.equal(validReg.data.role, 'admin');

    const rawAfterReg = await Tenant.findById(tenantId)
      .select('+registrationTokenHash +registrationTokenExpiresAt +adminCount')
      .lean();
    assert.equal(rawAfterReg.registrationTokenHash, undefined);
    assert.equal(rawAfterReg.registrationTokenExpiresAt, undefined);
    assert.equal(rawAfterReg.adminCount, 1);

    // 9.5. Tenant não inicializado cujo token expirou (>24h) não trava o nome permanentemente
    const abandonedRes = await apiRequest('/tenants', {
      method: 'POST',
      body: { name: 'Empresa Abandonada 24h', plan: 'freemium' },
    });
    assert.equal(abandonedRes.status, 201);
    const abandonedId = abandonedRes.data._id;
    const expiredToken = abandonedRes.data.registrationToken;

    await Tenant.updateOne(
      { _id: abandonedId },
      { $set: { registrationTokenExpiresAt: new Date(Date.now() - 60 * 1000) } }
    );

    const expiredRegAttempt = await apiRequest('/auth/register', {
      method: 'POST',
      body: {
        name: 'Admin Atrasado',
        email: 'atrasado@abandonada.com',
        password: 'Password123',
        tenantId: abandonedId,
        registrationToken: expiredToken,
      },
    });
    assert.equal(expiredRegAttempt.status, 403);

    const reclaimedRes = await apiRequest('/tenants', {
      method: 'POST',
      body: { name: 'Empresa Abandonada 24h', plan: 'freemium' },
    });
    assert.equal(reclaimedRes.status, 201);
    assert.notEqual(reclaimedRes.data._id, abandonedId);

    const reclaimedAdminReg = await apiRequest('/auth/register', {
      method: 'POST',
      body: {
        name: 'Admin Recriado',
        email: 'admin@recriada.com',
        password: 'Password123',
        tenantId: reclaimedRes.data._id,
        registrationToken: reclaimedRes.data.registrationToken,
      },
    });
    assert.equal(reclaimedAdminReg.status, 201);
  });

  it('10. Concorrência de adminCount: impede inflação em promoções simultâneas e bloqueia remoção mútua do último admin', async () => {
    await RateLimitBucket.deleteMany({});

    const tenantRes = await apiRequest('/tenants', {
      method: 'POST',
      body: { name: 'Concorrencia Admins Corp', plan: 'freemium' },
    });
    assert.equal(tenantRes.status, 201);
    const tenantId = tenantRes.data._id;

    const admin1Reg = await apiRequest('/auth/register', {
      method: 'POST',
      body: {
        name: 'Admin Um',
        email: 'admin1@concorrencia.com',
        password: 'Password123',
        tenantId,
      },
    });
    assert.equal(admin1Reg.status, 201);
    const admin1Id = admin1Reg.data._id;

    const admin1Login = await apiRequest('/auth/login', {
      method: 'POST',
      body: { email: 'admin1@concorrencia.com', password: 'Password123' },
    });
    const admin1Token = admin1Login.data.token;

    const memberRes = await apiRequest('/users', {
      method: 'POST',
      token: admin1Token,
      body: {
        name: 'Membro Promovivel',
        email: 'admin2@concorrencia.com',
        password: 'Password123',
      },
    });
    assert.equal(memberRes.status, 201);
    const admin2Id = memberRes.data._id;

    // 10.1. 4 promoções concorrentes do MESMO member -> adminCount fica exatamente 2 sem inflação
    const parallelPromotions = await Promise.all(
      Array.from({ length: 4 }, () =>
        apiRequest(`/users/${admin2Id}`, {
          method: 'PATCH',
          token: admin1Token,
          body: { role: 'admin' },
        })
      )
    );
    const validPromoStatuses = parallelPromotions.every(
      (r) => r.status === 200 || r.status === 409
    );
    assert.equal(
      validPromoStatuses,
      true,
      'Todas as respostas devem ser 200 (sucesso/idempotente) ou 409 (conflito)'
    );
    assert.ok(
      parallelPromotions.some((r) => r.status === 200),
      'Ao menos 1 requisição deve concluir com 200'
    );

    const tenantAfterPromo = await Tenant.findById(tenantId).select('+adminCount').lean();
    assert.equal(
      tenantAfterPromo.adminCount,
      2,
      'adminCount deve ser exatamente 2, sem inflação por requisições concorrentes'
    );

    // 10.2. Admin 1 e Admin 2 tentam excluir um ao outro simultaneamente -> apenas 1 exclusão vence, restando 1 admin
    const admin2Login = await apiRequest('/auth/login', {
      method: 'POST',
      body: { email: 'admin2@concorrencia.com', password: 'Password123' },
    });
    const admin2Token = admin2Login.data.token;

    const mutualDeletions = await Promise.all([
      apiRequest(`/users/${admin2Id}`, { method: 'DELETE', token: admin1Token }),
      apiRequest(`/users/${admin1Id}`, { method: 'DELETE', token: admin2Token }),
    ]);

    const succeededDel = mutualDeletions.filter((r) => r.status === 200);
    const blockedLastAdminDel = mutualDeletions.filter((r) => r.status === 400);
    assert.equal(succeededDel.length, 1, 'Apenas uma exclusão deve vencer a corrida');
    assert.equal(blockedLastAdminDel.length, 1, 'A segunda exclusão deve ser barrada com 400');

    const tenantFinal = await Tenant.findById(tenantId).select('+adminCount').lean();
    const actualRemainingAdmins = await User.countDocuments({ tenantId, role: 'admin' });
    assert.equal(tenantFinal.adminCount, 1);
    assert.equal(actualRemainingAdmins, 1);
  });

  it('11. Fallback resiliente do Rate Limiter em memória local com limitação (throttling) de logs', async () => {
    const failingStore = {
      async increment() {
        const err = new Error('Simulated shared store failure');
        err.name = 'MongoNetworkError';
        throw err;
      },
    };

    const limiter = createRateLimiter({
      scope: 'fallback-throttle-test',
      windowMs: 60 * 1000,
      maxRequests: 2,
      store: failingStore,
    });

    const invoke = (ip) =>
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
        limiter(req, res, () => resolve({ allowed: true, statusCode: 200, headers }));
      });

    const originalConsoleError = console.error;
    const warnings = [];
    console.error = (...args) => {
      warnings.push(args);
    };

    try {
      const r1 = await invoke('198.51.100.42');
      const r2 = await invoke('198.51.100.42');
      const r3 = await invoke('198.51.100.42');

      assert.equal(r1.allowed, true);
      assert.equal(r2.allowed, true);
      assert.equal(r3.allowed, false);
      assert.equal(r3.statusCode, 429);
      assert.equal(warnings.length, 1, 'Deve emitir apenas 1 aviso por janela de 60s');
      assert.match(String(warnings[0][0]), /usando memória local/i);

      // 11.2. Verifica que limiter com failClosed: true retorna 503 e loga bloqueio fail-closed específico
      const failClosedLimiter = createRateLimiter({
        scope: 'auth-failclosed-test',
        windowMs: 60 * 1000,
        maxRequests: 5,
        store: failingStore,
        failClosed: true,
      });

      const invokeFailClosed = (ip) =>
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
          failClosedLimiter(req, res, () => resolve({ allowed: true, statusCode: 200, headers }));
        });

      const fcResult = await invokeFailClosed('198.51.100.99');
      assert.equal(fcResult.allowed, false);
      assert.equal(fcResult.statusCode, 503);
      assert.equal(warnings.length, 2);
      assert.match(String(warnings[1][0]), /bloqueando requisições com 503 \(fail-closed\)/i);
      assert.ok(!String(warnings[1][0]).includes('usando memória local'));
    } finally {
      console.error = originalConsoleError;
    }
  });

});
