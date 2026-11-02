# SaaS App — API Multitenant (Node.js + Express 5 + MongoDB)

API RESTful para aplicação SaaS multitenant com gerenciamento de planos no MongoDB (`freemium` e `premium`), autenticação JWT (`HS256`), controle de acesso baseado em papéis (`admin` / `member`), reserva atômica de vagas por plano e isolamento estrito entre locatários (tenants).

## Requisitos

- **Node.js** `>= 20.19.0`
- **MongoDB** `>= 7.0` / `8.0`

## Configuração e Execução

1. Instale as dependências dentro da pasta `saas-app`:

```bash
cd saas-app
npm install
```

2. Configure o arquivo `saas-app/.env` (você pode gerar automaticamente com o script incluído):

```bash
# Cria o .env e gera uma JWT_SECRET criptográfica forte (64 bytes / 128 hex):
npm run setup:env
```

Ou copie manualmente de `saas-app/.env.example`:

```env
NODE_ENV=development
PORT=3000
MONGO_URI=mongodb://localhost:27017/saas
JWT_SECRET=substitua_por_uma_chave_aleatoria_com_no_minimo_32_caracteres
ALLOW_PUBLIC_MULTI_REGISTER=false
ALLOW_DIRECT_PLAN_CHANGE=false
RATE_LIMIT_STORE=mongodb
CORS_ORIGIN=*
TRUST_PROXY=
```

3. Inicie o servidor:

```bash
npm start
```

> Na inicialização, os planos padrão (`freemium`: até 3 usuários, `premium`: usuários ilimitados) são populados automaticamente na coleção `plans` caso ainda não existam.

O cadastro público de tenant aceita somente planos sem custo enquanto não houver integração de cobrança. A resposta de `POST /tenants` inclui um `registrationToken` de uso único, válido por 24 horas; envie esse valor em `POST /auth/register` junto com o `tenantId` para cadastrar o primeiro admin. Caso o prazo de 24 horas expire sem o cadastro do primeiro usuário (ou em tenants antigos ainda sem usuários), o nome é liberado automaticamente ao recriar o tenant em `POST /tenants` ou na reconciliação de inicialização.

Quando o mesmo e-mail está cadastrado em mais de um tenant com a mesma senha, o login retorna `409` e exige `tenantId` para identificar a conta. `ALLOW_PUBLIC_MULTI_REGISTER` e `ALLOW_DIRECT_PLAN_CHANGE` permanecem desativados em produção.

Com `RATE_LIMIT_STORE=mongodb`, os contadores são compartilhados entre instâncias. Se esse armazenamento falhar durante uma requisição, a API usa temporariamente o contador em memória local e registra um aviso limitado a 1 por minuto; esse fallback preserva disponibilidade, mas não compartilha o limite entre instâncias.

Nas rotas de login e registro, a API falha de forma fechada (`503`) se o rate limiter compartilhado em MongoDB estiver indisponível, evitando aceitar tentativas de autenticação sem o limite distribuído. As demais rotas mantêm o fallback local para priorizar disponibilidade.

Os eventos de indisponibilidade do rate limiter incluem o escopo, a quantidade de falhas desde o último aviso e a duração observada; quando o armazenamento MongoDB volta a responder, a API registra a recuperação. As tentativas de reconciliação de tenants registram resultado, duração, tentativa e quantidade de registros removidos.

Os endpoints `/health/live` e `/health/ready` separam a disponibilidade do processo da prontidão do serviço. O endpoint de prontidão testa o MongoDB e retorna `503` quando a dependência não responde.

O script `npm run setup:env` exige confirmação em terminal. Em execução não interativa, use `npm run setup:env -- --yes` somente quando quiser autorizar explicitamente a criação ou alteração do `.env`; a rotação de uma chave existente também requer `--force`.

O workflow de CI executa os testes unitários/de integração e os scripts end-to-end com Node.js 22, cobrindo MongoDB em replica set e standalone. A reconciliação de dados legados e exclusões pendentes permanece no startup para preservar a compatibilidade; em instalações grandes, avalie movê-la para uma migração/tarefa operacional controlada antes de remover essa garantia.

Consulte [docs/OPERATIONS.md](docs/OPERATIONS.md) para recomendações de backup, restauração e leitura dos sinais operacionais.

4. Execute a suíte de testes automatizados:

```bash
# Testes unitários e de integração interna (Node test runner)
npm test

# Suíte de scripts E2E próprios (test-scripts/)
npm run test:scripts
```

## Scripts Próprios de Teste (`test-scripts/`)

O projeto dispõe de uma pasta dedicada com scripts de teste de ponta a ponta que realizam chamadas HTTP reais contra a API:

- **`node test-scripts/run-all.js`**: Executa todas as suítes e emite relatório consolidado.
- **`node test-scripts/test-smoke.js`**: Validação de endpoints públicos, planos e headers de segurança/rate limit.
- **`node test-scripts/test-onboarding.js`**: Validação do ciclo de vida do `registrationToken` e bloqueio de planos pagos.
- **`node test-scripts/test-rbac.js`**: Validação de controle de papéis (`admin` vs `member`) e revogação imediata de token.
- **`node test-scripts/test-isolation.js`**: Validação do isolamento de tenants e unicidade de e-mail por empresa.
- **`node test-scripts/test-concurrency.js`**: Teste de carga e concorrência atômica sob limite de vagas e admins.
- **`node test-scripts/test-rate-limit.js`**: Teste de bloqueio HTTP 429 e `Retry-After`.

Consulte [test-scripts/README.md](file:///C:/Users/lucas/Downloads/Lucas/Capacita/Projeto_Inter_AR/test-scripts/README.md) para documentação completa.

## Execução no GitHub Codespaces / Dev Containers

O repositório inclui configuração pronta em `.devcontainer/` (**Node.js 22** + **MongoDB 8.0** com porta restrita à interface local `127.0.0.1` e configurado automaticamente como Replica Set `rs0`, com suporte nativo a transações ACID):

1. No GitHub, clique em **Code → Codespaces → Create codespace on main**.
2. Aguarde a inicialização automática (o script `.devcontainer/setup.js` instala as dependências e gera `saas-app/.env` com `JWT_SECRET` seguro e `TRUST_PROXY=1`).
3. No terminal do Codespace, inicie a API ou rode os testes:

```bash
cd saas-app
npm test
npm start
```

## Principais Endpoints

| Método | Rota | Autenticação | Papel | Descrição |
| :--- | :--- | :---: | :---: | :--- |
| `GET` | `/health/live` | Pública | — | Confirma que o processo da API está ativo |
| `GET` | `/health/ready` | Pública | — | Confirma que a API consegue consultar o MongoDB |
| `GET` | `/plans` | Pública | — | Lista os planos disponíveis cadastrados no MongoDB |
| `GET` | `/plans/:name` | Pública | — | Consulta detalhes de um plano específico |
| `POST` | `/tenants` | Pública (Rate Limited) | — | Cadastra tenant em plano gratuito e retorna token para o primeiro cadastro |
| `POST` | `/auth/register` | Pública (Rate Limited) | — | Registra o 1º usuário (`admin`) usando `tenantId` e `registrationToken` |
| `POST` | `/auth/login` | Pública (Rate Limited) | — | Autentica usuário ativo; aceita `tenantId` para distinguir contas |
| `GET` | `/tenants` | Bearer JWT | `admin`/`member` | Retorna o tenant do usuário autenticado |
| `GET` | `/tenants/:id` | Bearer JWT | `admin`/`member` | Consulta dados do próprio tenant |
| `PUT` / `PATCH` | `/tenants/:id` | Bearer JWT | `admin` | Atualiza dados do próprio tenant |
| `DELETE` | `/tenants/:id` | Bearer JWT | `admin` | Remove o tenant e todos os seus usuários |
| `GET` | `/tenants/:id/users` | Bearer JWT | `admin`/`member` | Lista usuários do próprio tenant (`?page=1&limit=50`) |
| `GET` | `/users` | Bearer JWT | `admin`/`member` | Lista usuários do próprio tenant (`?page=1&limit=50`) |
| `POST` | `/users` | Bearer JWT | `admin` | Cria novo usuário no tenant respeitando o limite atômico do plano |
| `GET` | `/users/:id` | Bearer JWT | `admin`/`member` | Consulta usuário do próprio tenant |
| `PUT` / `PATCH` | `/users/:id` | Bearer JWT | `admin` ou próprio usuário | Atualiza dados cadastrais/senha (alteração de `role` restrita a `admin`) |
| `DELETE` | `/users/:id` | Bearer JWT | `admin` | Remove usuário do tenant (bloqueia autoexclusão e remoção do único `admin`) |
