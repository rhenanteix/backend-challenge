<p align="center">
  <img src="https://encrypted-tbn0.gstatic.com/images?q=tbn:ANd9GcSsX_LICuvCuBGhFpeM7s2e4cCSpHWCwJlQGHdFNEwuZw&amp;s=10" alt="Jungle Gaming" width="250" />
</p>

Jungle Gaming — Wagering & Wallet Backend
Backend para processamento de movimentações de carteiras de jogadores, com ênfase em consistência financeira, idempotência, concorrência e mensageria assíncrona.
Escopo: projeto de desafio técnico. A infraestrutura e as credenciais apresentadas são destinadas exclusivamente ao ambiente local.

Tecnologias
TypeScript, NestJS, PostgreSQL, MikroORM, AWS SQS FIFO (emulado com LocalStack), Docker Compose, Vitest e Bun.
Pré-requisitos
- Docker e Docker Compose
- Node.js e Bun compatíveis com as versões declaradas no projeto
- AWS CLI (opcional, para inspecionar as filas manualmente)
Configuração e execução
1. Instale as dependências e prepare as variáveis de ambiente:
   bun install
   cp .env.example .env
2. Verifique os valores do .env. As configurações locais compartilhadas no desafio são:
   NODE_ENV=development
   PORT=3000
   
   DATABASE_HOST=localhost
   DATABASE_PORT=5432
   DATABASE_NAME=jungle_wagering
   DATABASE_USER=jungle
   DATABASE_PASSWORD=jungle_dev_password
   
   AWS_REGION=us-east-1
   AWS_ACCESS_KEY_ID=test
   AWS_SECRET_ACCESS_KEY=test
   SQS_ENDPOINT=http://localhost:4566
   SQS_QUEUE_NAME=wager-transactions.fifo
   SQS_DLQ_NAME=wager-transactions-dlq.fifo
   SQS_CONSUMER_ENABLED=true
   Atenção: SQS_CONSUMER_ENABLED foi identificada no worker, mas não constava do .env.example compartilhado. Inclua-a no arquivo de exemplo após confirmar a configuração do módulo de mensageria. Não utilize essas credenciais em produção.
3. Suba os serviços, execute as migrations e inicie a API:
   docker compose up -d
   bun run db:migrate
   bun run start:dev
   Por padrão, a API responde em http://localhost:3000. O provisionamento das filas depende da configuração de inicialização do LocalStack no Docker Compose. O script conhecido é docker/localstack/init-sqs.sh.
Filas locais
- Principal: wager-transactions.fifo
- DLQ: wager-transactions-dlq.fifo
- VisibilityTimeout: 60 segundos
- maxReceiveCount: 5
A política de redrive e as configurações FIFO estão no script docker/localstack/init-sqs.sh.
Endpoints
Método	Caminho	Finalidade
GET	/health/live	Liveness
GET	/health/ready	Readiness
POST	/wallets	Criar carteira
GET	/wallets/:walletId	Consultar carteira
GET	/wallets/:walletId/ledger	Consultar lançamentos
POST	/wallets/:walletId/reconciliation	Solicitar reconciliação
POST	/wagering/transactions	Processar transação
GET	/wagering/transactions/:transactionId	Consultar transação
GET	/providers/:providerId/wagering/transactions/:externalTransactionId	Consultar por referência externa


Os contratos detalhados de resposta, paginação e erros devem ser conferidos nos DTOs e controllers.
Exemplo: criar carteira
curl -X POST http://localhost:3000/wallets \
  -H 'Content-Type: application/json' \
  -d '{
    "playerId": "8c2578d1-9bc8-4f38-98f8-0f7e90d5422a",
    "currency": "BRL",
    "initialBalance": "100.00"
  }'
Guarde o identificador da carteira retornado.
Exemplo: processar uma BET
Substitua WALLET_UUID pelo identificador retornado na criação da carteira.
curl -X POST http://localhost:3000/wagering/transactions \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: example-bet-001' \
  -d '{
    "providerId": "jungle-provider",
    "externalTransactionId": "example-bet-001",
    "playerId": "8c2578d1-9bc8-4f38-98f8-0f7e90d5422a",
    "walletId": "WALLET_UUID",
    "roundId": "round-001",
    "gameId": "slot-001",
    "kind": "BET",
    "money": { "amount": "10.00", "currency": "BRL" }
  }'
A API exige o cabeçalho Idempotency-Key no processamento HTTP. O controller remove espaços nas extremidades e rejeita chaves vazias ou maiores que 255 caracteres.
Testes e qualidade
Para testes de integração, mantenha PostgreSQL, LocalStack e o consumidor da API em execução.
# Testes unitários
bunx vitest run src tests/unit

# Testes de integração
bunx vitest run --config vitest.config.integration.ts

# Tipos, lint e build
bunx tsc --noEmit
bun run lint
bun run build
Os cenários de integração exercitam ciclo financeiro, concorrência, idempotência, resiliência e recuperação por retry. O cenário de retry depende do timeout de visibilidade da fila e pode demorar aproximadamente um minuto.

Comandos adicionais disponíveis:
bun run db:status
bun run db:rollback
bun run start:prod
Nota: start:prod requer o build e a configuração apropriada de variáveis de ambiente.
Arquitetura
Consulte [ARCHITECTURE.md](./ARCHITECTURE.md) para conhecer as decisões de domínio, persistência e mensageria, bem como os trade-offs, limites de garantia e melhorias futuras.
Referências
Documentação oficial
- NestJS — Validation
- TypeScript — Type Assertions
- MikroORM — Transactions
- PostgreSQL — Explicit Locking
- PostgreSQL — Transaction Isolation
- AWS SQS — FIFO Queues
- AWS SQS — Visibility Timeout
- AWS SQS — Dead-Letter Queues
- LocalStack — SQS
- Vitest
- Decimal.js
Discussões consultadas e materiais complementares
- Stack Overflow — TypeScript e Record<string, string>
- GitHub — Slonik issue #452
- Transactional Outbox Pattern
- Idempotent Consumer Pattern
Os dois primeiros links foram compartilhados como pesquisas realizadas durante o desenvolvimento. Os demais são referências de documentação e estudo, sem implicar que cada solução tenha sido copiada ou implementada integralmente.
Licença
Projeto de desafio técnico para avaliação. Consulte as condições de uso e distribuição definidas pelo responsável pelo repositório.