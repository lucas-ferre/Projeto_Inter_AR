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

4. Execute a suíte de testes automatizados:

```bash
npm test
```

## Principais Endpoints

| Método | Rota | Autenticação | Papel | Descrição |
| :--- | :--- | :---: | :---: | :--- |
| `GET` | `/plans` | Pública | — | Lista os planos disponíveis cadastrados no MongoDB |
| `GET` | `/plans/:name` | Pública | — | Consulta detalhes de um plano específico |
| `POST` | `/tenants` | Pública (Rate Limited) | — | Cadastra um novo tenant vinculado a um plano válido |
| `POST` | `/auth/register` | Pública (Rate Limited) | — | Registra o 1º usuário (`admin`) do tenant recém-criado |
| `POST` | `/auth/login` | Pública (Rate Limited) | — | Autentica usuário ativo e emite token JWT (`1h`) |
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
