# 🔧 Troubleshooting - Persistência SQLite

## Problema: "Found 0 consumers in database to restore"

Este erro indica que o banco SQLite não estava persistindo os dados corretamente após crashes.

## ✅ Correções Aplicadas

### 1. **Sincronização Forçada (synchronous = FULL)**
```javascript
this.db.pragma('synchronous = FULL');
```
Garante que cada escrita seja confirmada no disco antes de continuar.

### 2. **Checkpoint WAL Após Cada Escrita**
```javascript
this.db.pragma('wal_checkpoint(FULL)');
```
Após salvar, deletar ou atualizar um consumer, força a gravação do WAL para o arquivo principal.

### 3. **Checkpoint Final Antes de Fechar**
```javascript
this.db.pragma('wal_checkpoint(TRUNCATE)');
this.db.close();
```
Antes de sair (graceful shutdown ou exit por erro), faz checkpoint completo.

### 4. **Endpoint de Debug**
```
GET /debug/db
```
Retorna o estado atual do banco de dados, incluindo:
- Path do banco
- Tamanho do arquivo
- Última modificação
- Lista de todos os consumers salvos

## 🧪 Como Testar

### 1. **Verificar Salvamento**
```bash
# Criar um consumer
curl -X POST http://gate.iszap.com.br/consume \
  -H "Content-Type: application/json" \
  -d '{
    "queue": "teste-persistencia",
    "webhook": "https://webhook.site/xxx",
    "minInterval": 30000,
    "maxInterval": 60000
  }'

# Verificar se foi salvo
curl http://gate.iszap.com.br/debug/db
```

Você deve ver:
```json
{
  "database_path": "/data/consumers.db",
  "file_size": 12288,
  "consumers": [
    {
      "queue": "teste-persistencia",
      "webhook": "https://webhook.site/xxx",
      ...
    }
  ],
  "count": 1
}
```

### 2. **Verificar Persistência Após Crash**
```bash
# 1. Criar consumer
curl -X POST http://gate.iszap.com.br/consume -H "Content-Type: application/json" -d '{"queue":"teste","webhook":"https://webhook.site/xxx"}'

# 2. Verificar que foi salvo
curl http://gate.iszap.com.br/debug/db

# 3. Forçar restart do container
docker service update --force consumer_consumer

# 4. Aguardar container iniciar (10-20 segundos)
sleep 20

# 5. Verificar logs - deve mostrar restauração
docker service logs consumer_consumer --tail 50

# 6. Verificar banco novamente
curl http://gate.iszap.com.br/debug/db
```

### 3. **Ver Logs de Persistência**

Procure por estes logs:

**Ao Salvar:**
```
✅ Saved and synced consumer config for queue teste to database
```

**Ao Deletar:**
```
✅ Deleted and synced consumer config for queue teste from database
```

**Ao Carregar:**
```
📁 Database file size: 12288 bytes, modified: ...
📊 Found 1 consumers in database to restore
Consumers to restore: teste
```

## 🐛 Debug de Problemas

### Volume Não Está Persistindo

```bash
# Verificar se o volume existe
docker volume ls | grep consumer-data

# Inspecionar volume
docker volume inspect consumer-data

# Ver conteúdo do volume
docker run --rm -v consumer-data:/data alpine ls -la /data
```

### Banco de Dados Está Vazio

```bash
# Entrar no container
docker exec -it $(docker ps -q -f name=consumer) sh

# Verificar arquivo existe
ls -lh /data/

# Ver tamanho dos arquivos
du -h /data/*

# Verificar conteúdo do banco (se sqlite3 estiver instalado)
# sqlite3 /data/consumers.db "SELECT * FROM consumers;"
```

### Permissões

```bash
# Verificar permissões dentro do container
docker exec -it $(docker ps -q -f name=consumer) ls -la /data/

# Deve mostrar:
# drwxr-xr-x 2 nodejs nodejs ...  /data
```

### WAL Files

O SQLite em modo WAL cria 3 arquivos:
- `consumers.db` - arquivo principal
- `consumers.db-wal` - write-ahead log
- `consumers.db-shm` - shared memory

```bash
docker exec -it $(docker ps -q -f name=consumer) ls -la /data/
```

## 📊 Métricas de Sucesso

Após as correções, você deve ver:

1. **File size > 0** após criar consumer
2. **Logs com ✅** confirmando salvamento
3. **Consumers restaurados** após restart
4. **WAL checkpoint status** nos logs

## ⚠️ Se Ainda Falhar

Se após todas as correções o problema persistir:

### Opção 1: Verificar Volume Docker

O volume pode estar sendo recriado em vez de reutilizado:

```bash
# Ver histórico do volume
docker volume inspect consumer-data

# Verificar se está atachado ao serviço correto
docker service inspect consumer_consumer --format '{{json .Spec.TaskTemplate.ContainerSpec.Mounts}}'
```

### Opção 2: Usar Path Local (Bind Mount)

Em `docker-compose.yml`, mudar de volume gerenciado para bind mount:

```yaml
volumes:
  - /opt/consumer-data:/data  # Path absoluto no host
```

### Opção 3: Desabilitar WAL Temporariamente

Se WAL estiver causando problemas, testar com DELETE mode:

```javascript
// No index.js, linha 49
this.db.pragma('journal_mode = DELETE');  // Em vez de WAL
this.db.pragma('synchronous = FULL');
```

## 🚀 Deploy das Correções

```bash
# Rebuild
docker build -t rabbitmq-consumer:latest .

# Update do serviço (sem downtime)
docker service update --image rabbitmq-consumer:latest consumer_consumer

# Verificar logs
docker service logs consumer_consumer -f
```

## 📞 Checklist Final

- [ ] Rebuild da imagem feito
- [ ] Service atualizado
- [ ] Endpoint `/debug/db` acessível
- [ ] Consumer criado via API
- [ ] `/debug/db` mostra consumer salvo
- [ ] Restart forçado executado
- [ ] Logs mostram "Found X consumers to restore"
- [ ] Consumers foram restaurados com sucesso


