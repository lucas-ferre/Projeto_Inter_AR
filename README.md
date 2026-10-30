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

2. Crie o arquivo `saas-app/.env` a partir de `saas-app/.env.example`:

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

4. Execute a suíte de testes automatizados:

```bash
npm test
```

## Execução no GitHub Codespaces / Dev Containers

O repositório inclui configuração pronta em `.devcontainer/` (**Node.js 22** + **MongoDB 8.0** configurado automaticamente como Replica Set `rs0`, com suporte nativo a transações ACID):

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
