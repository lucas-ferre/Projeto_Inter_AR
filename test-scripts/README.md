# Scripts Próprios de Teste do Sistema (E2E & Integração)

Conjunto de scripts automatizados em Node.js puro (sem dependências externas) para validação de ponta a ponta da API SaaS Multitenant.

Estes scripts realizam chamadas HTTP reais contra a API em execução (`http://localhost:3000` por padrão ou a URL definida na variável `API_URL`), testando regras de negócio, segurança, concorrência atômica, isolamento de dados e limites de planos.

> **Detecção Inteligente:** Caso o servidor da API não esteja rodando quando um script for iniciado, o utilitário inicia o processo localmente em segundo plano de forma automática, aguarda a inicialização, executa os testes e encerra o processo de forma limpa ao final.

---

## Estrutura dos Scripts

| Arquivo | Descrição |
| :--- | :--- |
| **`run-all.js`** | **Orquestrador principal**: executa todas as suítes em sequência e exibe relatório consolidado com tempos e status. |
| **`test-smoke.js`** | Valida a saúde da API, endpoint `/plans`, cabeçalhos de segurança (Helmet), cabeçalhos de Rate Limit IETF e rota 404. |
| **`test-onboarding.js`** | Valida rejeição de planos pagos sem faturamento, criação de tenant, geração de `registrationToken` (64 hex), validação e consumo do token no 1º registro de admin. |
| **`test-rbac.js`** | Valida o controle de papéis (`admin` vs `member`): bloqueio de ações administrativas por membros, atualização de perfil próprio, proteção contra autoexclusão e revogação imediata de JWT após exclusão. |
| **`test-isolation.js`** | Valida o isolamento estrito entre `Tenant A` e `Tenant B` (bloqueio 403/404 em consultas e mutações cruzadas), e unicidade de e-mail por tenant com login desambiguado. |
| **`test-concurrency.js`** | Valida atomicidade sob carga: 5 criações concorrentes disputando 2 vagas no freemium, promoções simultâneas sem inflar `adminCount` e proteção contra exclusão mútua do último admin. |
| **`test-rate-limit.js`** | Valida decréscimo progressivo de cota e bloqueio `429 Too Many Requests` com cabeçalho `Retry-After`. |
| **`test-utils.js`** | Utilitários compartilhados (cliente HTTP nativo, asserções, cores ANSI no terminal e auto-spawn do servidor). |

---

## Como Executar

### 1. Executar Todas as Suítes

A partir da raiz do repositório:

```bash
node test-scripts/run-all.js
```

Ou a partir da pasta `saas-app`:

```bash
cd saas-app
npm run test:scripts
```

---

### 2. Executar uma Suíte Específica

Você pode rodar qualquer script individualmente para validar uma funcionalidade específica:

```bash
# Smoke & Health Check
node test-scripts/test-smoke.js

# Onboarding & Tokens
node test-scripts/test-onboarding.js

# Controle de Acesso (RBAC)
node test-scripts/test-rbac.js

# Isolamento Multitenant
node test-scripts/test-isolation.js

# Concorrência Atômica & Proteção de Admins
node test-scripts/test-concurrency.js

# Rate Limiting
node test-scripts/test-rate-limit.js
```

---

### 3. Testar Contra Outro Ambiente (Codespaces, Docker, Staging)

Defina a variável de ambiente `API_URL`:

```bash
# Exemplo no Linux / macOS / WSL:
API_URL=http://localhost:8080 node test-scripts/run-all.js

# Exemplo no Windows PowerShell:
$env:API_URL="http://localhost:3000"; node test-scripts/run-all.js
```
