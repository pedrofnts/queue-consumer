# Migração Redis → SQLite

## Resumo das Mudanças

O serviço foi migrado de **Redis** para **SQLite** para persistência de configurações de consumers, resolvendo problemas de confiabilidade e simplificando a arquitetura.

## Problemas Corrigidos

### 1. **Bug Crítico - Consumers não eram deletados do banco quando filas terminavam**
- **Problema**: Quando uma fila ficava vazia e o consumer era automaticamente removido, a configuração permanecia no Redis
- **Sintoma**: Após reiniciar o serviço, tentava restaurar consumers para filas inexistentes
- **Solução**: Adicionado `deleteConsumerFromDb(queue)` quando `messageCount === 0` (linha 730)

### 2. **Falhas Silenciosas de Persistência**
- **Problema**: Erros de Redis eram apenas logados, mas o código continuava executando
- **Solução**: Agora o processo **sai com exit(1)** em qualquer falha crítica de banco de dados, forçando reinicialização e restauração do estado

### 3. **Race Condition no Estado de Pausa**
- **Problema**: Estado de pausa era restaurado DEPOIS de iniciar o consumo
- **Solução**: Estado de pausa agora é definido IMEDIATAMENTE após criar o consumer

## Vantagens do SQLite sobre Redis

1. **Sem dependência externa**: Não precisa de serviço Redis rodando
2. **ACID compliant**: Garantias de consistência transacional
3. **File-based**: Backup e migração mais simples (copiar arquivo)
4. **Zero configuração**: Funciona out-of-the-box
5. **Mais leve**: Menos recursos e complexidade

## Mudanças Necessárias

### 1. Package.json
```diff
- "ioredis": "^5.3.2"
+ "better-sqlite3": "^9.2.2"
```

### 2. Environment Variables
```diff
- REDIS_URL=redis://localhost:6379
+ DB_PATH=/data/consumers.db
```

### 3. Docker Compose
Adicionado volume para persistência:
```yaml
volumes:
  - consumer-data:/data
```

E definição do volume:
```yaml
volumes:
  consumer-data:
    driver: local
```

## Schema do Banco de Dados

```sql
CREATE TABLE consumers (
    queue TEXT PRIMARY KEY,
    webhook TEXT NOT NULL,
    minInterval INTEGER NOT NULL,
    maxInterval INTEGER NOT NULL,
    businessHoursStart INTEGER NOT NULL,
    businessHoursEnd INTEGER NOT NULL,
    paused INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
)
```

## Comportamento de Exit em Falhas Críticas

O serviço agora **sai com código 1** nas seguintes situações:

1. **Falha ao inicializar banco de dados** (construtor)
2. **Falha ao salvar consumer** (`saveConsumerToDb`)
3. **Falha ao deletar consumer** (`deleteConsumerFromDb`)
4. **Falha ao atualizar estado de pausa** (`updateConsumerPausedState`)
5. **Falha ao carregar consumers** (`loadConsumersFromDb`)
6. **Limite de tentativas de reconexão excedido** (após `MAX_RECONNECT_ATTEMPTS`)

### Por que Exit?

Quando uma operação crítica de banco falha, o estado em memória fica inconsistente com o estado persistido. Ao sair, forçamos o container a reiniciar, o que:

1. Limpa qualquer estado corrompido em memória
2. Restaura o último estado consistente do banco de dados
3. Permite ao orquestrador (Docker/Kubernetes) aplicar políticas de retry
4. Mantém a integridade dos dados

## Deploy

### Primeira Instalação (Novo Deploy)
```bash
# Instalar dependências
npm install

# Rebuild da imagem Docker
docker build -t rabbitmq-consumer:latest .

# Deploy
docker stack deploy -c docker-compose.yml consumer
```

### Migração de Instalação Existente

⚠️ **ATENÇÃO**: Esta migração **não preserva** consumers ativos no Redis anterior.

**Opção 1: Migração Manual (Recomendado para Production)**
```bash
# 1. Antes de fazer deploy, liste os consumers ativos
curl http://gate.iszap.com.br/active-queues

# 2. Salve as configurações dos consumers

# 3. Faça o deploy da nova versão
npm install
docker build -t rabbitmq-consumer:latest .
docker stack deploy -c docker-compose.yml consumer

# 4. Recrie os consumers via API
curl -X POST http://gate.iszap.com.br/consume \
  -H "Content-Type: application/json" \
  -d '{
    "queue": "nome-da-fila",
    "webhook": "https://seu-webhook.com",
    "minInterval": 30000,
    "maxInterval": 110000,
    "businessHours": {"start": 8, "end": 21}
  }'
```

**Opção 2: Deploy Direto (Aceita Perda de Estado)**
```bash
npm install
docker build -t rabbitmq-consumer:latest .
docker stack deploy -c docker-compose.yml consumer
```

## Verificação Pós-Deploy

```bash
# Health check
curl http://gate.iszap.com.br/health

# Verificar consumers ativos
curl http://gate.iszap.com.br/active-queues

# Ver logs
docker service logs consumer_consumer -f
```

## Localização do Banco de Dados

- **Path no container**: `/data/consumers.db`
- **Volume Docker**: `consumer-data` (managed volume)
- **Backup**: Para fazer backup, copie o arquivo do volume

```bash
# Identificar o container
docker ps | grep consumer

# Copiar banco para local
docker cp <container_id>:/data/consumers.db ./backup_consumers.db
```

## Rollback

Se necessário reverter para a versão com Redis:

```bash
# 1. Checkout da versão anterior do código
git checkout <commit-anterior>

# 2. Rebuild
docker build -t rabbitmq-consumer:latest .

# 3. Atualizar docker-compose.yml para remover volume e adicionar Redis
# 4. Deploy
docker stack deploy -c docker-compose.yml consumer
```

## Notas Técnicas

- **WAL Mode**: SQLite está configurado com `journal_mode = WAL` para melhor concorrência
- **Transações**: Cada operação de escrita é uma transação atômica
- **Sincronização**: SQLite é thread-safe, mas melhor usar sincronamente (já implementado)
- **Performance**: Para este caso de uso (poucas escritas), SQLite é mais que suficiente

