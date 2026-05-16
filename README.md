# Saudy API Monolith

API monolítica em Fastify que consolida os domínios de `auth`, `accounts`, `admin`, `care` e `procedures` em um único serviço.

## Objetivo

Este repositório centraliza os antigos microserviços em uma aplicação única, com:

- um único servidor HTTP (`src/server.ts`),
- um único ponto de registro de módulos (`src/app.ts`),
- um único schema Prisma (`prisma/schema.prisma`),
- um único banco PostgreSQL.

## Pré-requisitos

Antes de começar, garanta que você tem instalado:

- Node.js 20+
- pnpm 10+
- Docker + Docker Compose

## Começando do zero (ordem recomendada)

### 1) Instalar dependências

```bash
pnpm install
```

### 2) Subir o banco no Docker

```bash
docker compose up -d --build
```

O Postgres sobe com estes dados (definidos no `docker-compose.yml`):

- Host: `localhost`
- Porta: `5432`
- Database: `saudy_db`
- Usuário: `saudy_user`
- Senha: `saudy_password`

### 3) Configurar variáveis de ambiente

```bash
cp .env.example .env
```

Confirme no `.env`:

```dotenv
DATABASE_URL=postgresql://saudy_user:saudy_password@localhost:5432/saudy_db
JWT_SECRET=troque-para-um-segredo-forte
PORT=3000
```

### 4) Aplicar migrações do banco

```bash
pnpm prisma migrate dev
```

### 5) Gerar client do Prisma

```bash
pnpm prisma:generate
```

### 6) Rodar a API em desenvolvimento

```bash
pnpm dev
```

Se tudo estiver certo:

- API: `http://localhost:3000`
- Healthcheck: `http://localhost:3000/health`
- Swagger: `http://localhost:3000/docs`

## Mapa do projeto

```text
src/
	app.ts                 # Configura Fastify, JWT, CORS, Swagger e registra módulos
	server.ts              # Inicializa servidor e conexão com banco
	lib/
		prisma.ts            # Instância Prisma Client
		prisma-adapter.ts    # Adapter pg + schema public
	modules/
		auth/
		accounts/
		admin/
		care/
		procedures/
prisma/
	schema.prisma          # Schema único da aplicação
	migrations/            # Histórico de migrações
```

## O que cada módulo faz

### `auth` (`/auth/*`)

Responsável por autenticação e estrutura organizacional:

- autenticação (`/auth`)
- empresas (`/companies`)
- filiais (`/branches`)
- setores (`/sectors`)
- acessos/perfis (`/accesses`)
- módulos/permissões (`/modules`)
- usuários (`/users`)

### `accounts` (`/accounts/*`)

Responsável pelo núcleo clínico de cadastro:

- médicos (`/doctors`)
- pacientes (`/patients`)
- prontuários (`/medical-records`)

### `admin` (`/admin/*`)

Responsável por operações administrativas:

- estoque (`/inventory`)
- financeiro (`/finance`)
- faturas (`/invoices`)
- entregas (`/deliveries`)

### `care` (`/care/*`)

Responsável pelo fluxo de atendimento:

- pré-atendimento (`/pre-attendances`)
- agendamentos (`/appointments`)
- consultas (`/consultations`)
- relatórios (`/reports`)
- envolvimentos (`/envelopments`)
- documentos (`/documents`)

### `procedures` (`/procedures/*`)

Responsável por procedimentos e convênios:

- procedimentos (`/procedures`)
- convênios (`/insurances`)

## Scripts úteis

- `pnpm dev`: roda em modo desenvolvimento (com watch)
- `pnpm build`: gera build TypeScript em `dist/`
- `pnpm start`: sobe aplicação compilada
- `pnpm prisma:generate`: gera Prisma Client

## Primeira contribuição (guia rápido)

Para começar sem se perder:

1. Suba o projeto com o passo a passo da seção “Começando do zero”.
2. Abra o Swagger em `/docs` e identifique a rota do módulo que você vai alterar.
3. Encontre o módulo correspondente em `src/modules/<modulo>/routes`.
4. Se mudar modelo de dados, ajuste `prisma/schema.prisma` e rode migração.
5. Teste localmente via Swagger antes de abrir PR.

## Observações importantes

- A pasta `generated/` contém artefatos gerados e não é fonte principal de desenvolvimento.
- O monólito usa schema PostgreSQL `public` via adapter em `src/lib/prisma-adapter.ts`.
- O endpoint de `accounts/appointments` existe no código legado desse domínio, mas não está registrado no módulo `accounts` atual.

## Deploy no Google Cloud Run

Este repositório já está preparado para deploy automático no Cloud Run com GitHub Actions em `.github/workflows/deploy-cloud-run.yml`.

### 1. Pré-requisitos no GCP

1. Crie/provisione um projeto GCP.
2. Ative APIs:
   `Artifact Registry`, `Cloud Run`, `Cloud Build`, `IAM`, `Secret Manager`.
3. Crie um repositório Docker no Artifact Registry:
   `gcloud artifacts repositories create saudy --repository-format=docker --location=us-central1`
4. Configure Workload Identity Federation para GitHub Actions e vincule uma service account com permissões de deploy (`roles/run.admin`, `roles/artifactregistry.writer`, `roles/iam.serviceAccountUser`).

### 2. Configuração de secrets

No GitHub, adicione:

- `GCP_PROJECT_ID`
- `GCP_WORKLOAD_IDENTITY_PROVIDER`
- `GCP_SERVICE_ACCOUNT`

No Secret Manager (GCP), crie os secrets usados no deploy, como:

- `DATABASE_URL`
- `JWT_SECRET`
- `CORS_ORIGIN`
- `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `SMTP_SECURE`, `SMTP_FROM`
- `GROQ_API_KEY`
- `ORTHANC_URL`, `ORTHANC_AUTH`
- `GOOGLE_STORAGE_BUCKET_DICOM`, `GOOGLE_STORAGE_BUCKET_ANEXOS`
- `MWL_BRANCH_ID`, `MWL_PUBLIC_TOKEN`
- `WHATSAPP_CHATBOT_BRANCH_ID`

### 3. Deploy

1. Faça push na branch `main` (ou rode manualmente em **Actions > Deploy to Cloud Run**).
2. O workflow irá:
   - buildar a imagem Docker
   - publicar no Artifact Registry
   - fazer deploy no serviço `saudy-api-monolith` no Cloud Run
