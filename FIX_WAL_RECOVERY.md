# 🔥 FIX CRÍTICO - Recuperação de Dados do WAL

## O Problema Real

Você estava vendo nos logs:
```
📁 Database file size: 12288 bytes
📁 WAL file size: 8272 bytes  ← DADOS AQUI!
WAL checkpoint status: [ { busy: 0, log: 2, checkpointed: 2 } ]
📊 Found 0 consumers in database to restore  ← MAS NÃO ENCONTRA!
```

**Os dados ESTAVAM no banco, mas no arquivo WAL**, não no arquivo principal!

## Por Que Acontecia?

### Ciclo do Problema

1. **Você cria um consumer** → `saveConsumerToDb()`
2. **Dados são escritos no WAL** (consumers.db-wal)
3. **Checkpoint FULL é executado** → Deveria mover dados para arquivo principal
4. **MAS... RabbitMQ crasha o channel** → Processo é interrompido
5. **Container reinicia rápido demais** → SQLite não teve tempo de consolidar
6. **Banco abre novamente** → SQLite NÃO consolida WAL automaticamente ao abrir
7. **Query SELECT roda** → Só lê arquivo principal (que está vazio/antigo)
8. **Resultado: 0 consumers encontrados** 😢

### Por Que WAL Não Era Consolidado?

O SQLite em modo WAL **não consolida automaticamente** ao abrir o banco. Ele espera por:
- Checkpoint manual
- Ou acúmulo de frames suficientes
- Ou fechamento limpo do banco

Em crashes, o WAL fica com dados **válidos mas não consolidados**.

## A Solução

### Checkpoint RESTART ao Abrir Banco

```javascript
// ANTES (ERRADO)
this.db = new Database(DB_PATH);
this.db.pragma('journal_mode = WAL');
// ... queries aqui não veem dados do WAL!

// DEPOIS (CORRETO)
this.db = new Database(DB_PATH);
// 1️⃣ PRIMEIRO: Consolidar WAL de crashes anteriores
const restoreCheckpoint = this.db.pragma('wal_checkpoint(RESTART)');
console.log('WAL restore checkpoint result:', restoreCheckpoint);
// 2️⃣ DEPOIS: Configurar WAL novamente
this.db.pragma('journal_mode = WAL');
// 3️⃣ Agora queries veem todos os dados!
```

### Tipos de Checkpoint

| Tipo | Comportamento |
|------|---------------|
| `PASSIVE` | Tenta consolidar, mas não bloqueia. Pode falhar se houver writers |
| `FULL` | Consolida tudo, espera writers terminarem |
| `RESTART` | FULL + reseta WAL (melhor para recovery) |
| `TRUNCATE` | RESTART + trunca arquivo WAL para 0 bytes |

**RESTART é ideal para recovery** porque:
- Consolida TODO o WAL
- Reseta o WAL para novo ciclo
- Garante que dados são visíveis

## Verificação

### Logs de Sucesso

Após a correção, você deve ver:

**Na Inicialização:**
```
Attempting to initialize SQLite at: /data/consumers.db
Database directory: /data
Consolidating WAL on database open...
WAL restore checkpoint result: [ { busy: 0, log: 0, checkpointed: 0 } ]
SQLite database initialized successfully at: /data/consumers.db
```

**Ao Carregar Consumers:**
```
📁 Database file size: 20480 bytes
📁 WAL file size: 0 bytes  ← DEVE SER 0 ou pequeno!
📊 Found 2 consumers in database to restore
✅ Consumers to restore: queue1, queue2
```

### Como Testar

```bash
# 1. Rebuild
docker build -t rabbitmq-consumer:latest .

# 2. Deploy
docker service update --image rabbitmq-consumer:latest consumer_consumer

# 3. Criar consumer
curl -X POST http://gate.iszap.com.br/consume \
  -H "Content-Type: application/json" \
  -d '{"queue":"teste-recovery","webhook":"https://webhook.site/xxx"}'

# 4. Verificar foi salvo
curl http://gate.iszap.com.br/debug/db

# 5. SIMULAR CRASH - matar processo abruptamente
docker kill $(docker ps -q -f name=consumer)

# 6. Aguardar container reiniciar (Docker faz automaticamente)
sleep 15

# 7. Verificar logs
docker service logs consumer_consumer --tail 100

# Deve mostrar:
# - "Consolidating WAL on database open..."
# - "Found 1 consumers in database to restore"
# - "✅ Consumers to restore: teste-recovery"
```

## Arquivos WAL

O SQLite em modo WAL cria 3 arquivos:

```bash
/data/consumers.db       # Arquivo principal
/data/consumers.db-wal   # Write-Ahead Log (mudanças pendentes)
/data/consumers.db-shm   # Shared Memory (coordenação)
```

### Estados Esperados

**Após Escrita Normal:**
```
consumers.db: 12288 bytes
consumers.db-wal: 8272 bytes  ← Dados aqui
consumers.db-shm: 32768 bytes
```

**Após Checkpoint Bem-Sucedido:**
```
consumers.db: 20480 bytes  ← Dados consolidados aqui
consumers.db-wal: 0 bytes  ← WAL vazio ou pequeno
consumers.db-shm: 32768 bytes
```

## Monitoramento

### Endpoint de Debug

```bash
curl http://gate.iszap.com.br/debug/db
```

Retorna:
```json
{
  "database_path": "/data/consumers.db",
  "file_size": 20480,
  "modified": "2025-11-05T13:30:00.000Z",
  "consumers": [
    {
      "queue": "teste",
      "webhook": "https://...",
      ...
    }
  ],
  "count": 1
}
```

### Alertas nos Logs

Se você ver:
```
⚠️  WARNING: WAL file has data - checkpoint should have been done on open
```

Isso indica que o checkpoint RESTART não funcionou corretamente. Possíveis causas:
- Arquivo corrompido
- Permissões incorretas
- Filesystem com problemas

## Comparação: Antes vs Depois

### ❌ Antes (Com Bug)

1. Consumer criado → Dados no WAL
2. Crash → WAL com 8272 bytes
3. Restart → Banco abre
4. Query SELECT → Lê só arquivo principal (vazio)
5. **Resultado: 0 consumers** 💥

### ✅ Depois (Corrigido)

1. Consumer criado → Dados no WAL
2. Crash → WAL com 8272 bytes
3. Restart → Banco abre
4. **Checkpoint RESTART → Move dados do WAL para arquivo principal** ⚡
5. Query SELECT → Lê arquivo principal (com dados)
6. **Resultado: 1 consumer restaurado** ✅

## Por Que Não Desabilitar WAL?

Você pode estar pensando: "Por que não usar DELETE mode?"

```javascript
// Alternativa: Desabilitar WAL
this.db.pragma('journal_mode = DELETE');
this.db.pragma('synchronous = FULL');
```

**Prós:**
- Mais simples
- Sem complexidade de WAL
- Dados sempre no arquivo principal

**Contras:**
- **Performance muito pior** (cada escrita bloqueia todo o banco)
- Mais lento para múltiplas escritas
- Não é necessário - WAL funciona bem com checkpoint correto

WAL é **superior** quando usado corretamente!

## Deploy da Correção

```bash
# 1. Rebuild (OBRIGATÓRIO)
docker build -t rabbitmq-consumer:latest .

# 2. Update do serviço
docker service update --image rabbitmq-consumer:latest consumer_consumer

# 3. Verificar logs
docker service logs consumer_consumer -f

# Procure por:
# "Consolidating WAL on database open..."
# "WAL restore checkpoint result: ..."
```

## Conclusão

O problema **não era que o banco não estava salvando** - ele ESTAVA salvando!

O problema era que **os dados ficavam no WAL e não eram consolidados após crashes**.

A solução é **simples mas crítica**: fazer checkpoint RESTART ao abrir o banco, ANTES de qualquer leitura.

Agora seus consumers vão **sempre** ser recuperados após crashes! 🎉

