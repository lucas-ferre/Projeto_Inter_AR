# Operação: saúde, sinais e recuperação de dados

## Endpoints de saúde

- `GET /health/live` responde `200` quando o processo Express está atendendo. Use para liveness; ele não consulta o MongoDB.
- `GET /health/ready` envia um `ping` ao MongoDB e responde `200` quando a dependência está disponível. Retorna `503` se a conexão estiver fechada, falhar ou não responder dentro de 1 segundo. Use para readiness e para retirar temporariamente a instância do tráfego.

Ambos enviam `Cache-Control: no-store` e não passam pelo rate limiter global.

## Sinais operacionais nos logs

O rate limiter limita avisos repetidos, mas registra o escopo, modo (`fail-open` ou `fail-closed`), quantidade de falhas desde o aviso anterior e duração da indisponibilidade. Quando o MongoDB volta a responder, registra a duração e o total de falhas daquela indisponibilidade.

Essas contagens são locais a cada instância da API e a cada escopo de rate limiter; agregue os eventos na plataforma de logs usando os campos `scope` e o identificador da instância.

Os eventos `[TenantCleanup]` identificam sucesso ou falha, número da tentativa, duração e quantidades de tenants/usuários removidos. Uma falha que chega ao limite de tentativas deixa o tombstone `deleting` bloqueando o tenant; a reconciliação de inicialização tenta concluir a limpeza quando a aplicação voltar.

Configure sua plataforma de logs para alertar sobre:

- rate limiter em `fail-closed`, pois login e cadastro retornarão `503`;
- períodos longos de `fail-open`, pois o contador em memória não é compartilhado entre instâncias;
- `TenantCleanup` com `outcome=failure` repetido ou tentativa máxima atingida.

## Backup local e teste de restauração

Os comandos abaixo usam o MongoDB local do Dev Container e requerem MongoDB Database Tools instaladas (`mongodump`, `mongorestore` e `mongosh`). O diretório `backups/` está ignorado pelo Git.

No PowerShell, crie um dump comprimido:

```powershell
$backupDir = Join-Path (Get-Location) 'backups'
New-Item -ItemType Directory -Force -Path $backupDir | Out-Null
$backupFile = Join-Path $backupDir ("saas-{0}.archive.gz" -f (Get-Date -Format 'yyyyMMdd-HHmmss'))
mongodump --uri='mongodb://127.0.0.1:27017/saas' --archive="$backupFile" --gzip
```

Para restaurar, use uma instância de teste e um banco separado. Este exemplo mapeia as coleções do dump `saas` para `saas_restore_check`:

```powershell
mongorestore --uri='mongodb://127.0.0.1:27017/saas_restore_check' --archive="$backupFile" --gzip --nsFrom='saas.*' --nsTo='saas_restore_check.*' --drop
mongosh 'mongodb://127.0.0.1:27017/saas_restore_check' --eval 'db.getCollectionNames()'
```

Confirme que as coleções esperadas existem e compare contagens representativas com a origem antes de considerar o exercício concluído. Não restaure um dump diretamente sobre produção durante atendimento de tráfego.

Para ambientes de produção, defina um objetivo de ponto de recuperação (RPO) e um tempo de recuperação (RTO), retenha cópias criptografadas fora do host da aplicação e teste restaurações periodicamente. Prefira snapshots gerenciados e recuperação point-in-time do provedor MongoDB quando disponíveis; o dump lógico acima é um procedimento simples para desenvolvimento e validação, não uma estratégia completa de recuperação de desastre. Mantenha credenciais fora do repositório e dos logs.

## Exercitar o caminho standalone

O teste de integração remove o banco apontado por `STANDALONE_MONGO_URI` no início e no fim. Use somente uma instância descartável:

```powershell
docker compose -f .github/docker-compose.standalone.yml up -d --wait
$env:STANDALONE_MONGO_URI = 'mongodb://127.0.0.1:27018/saas_standalone_test'
npm run test:standalone --prefix saas-app
docker compose -f .github/docker-compose.standalone.yml down
Remove-Item Env:STANDALONE_MONGO_URI
```
