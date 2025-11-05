# 🚀 Deploy Rápido

## Problema Resolvido

O erro `unable to open database file` foi causado por:
1. ❌ Falta de build tools para compilar `better-sqlite3`
2. ❌ Diretório `/data` não existia no container
3. ❌ Usuário `nodejs` não tinha permissões no diretório `/data`

## Correções Aplicadas

### ✅ Dockerfile
- Instalado build tools: `python3`, `make`, `g++`
- Criado diretório `/data` 
- Dado ownership para usuário `nodejs`

### ✅ index.js
- Melhorado logging para debug
- Adicionado informações de permissões em caso de erro

## Deploy Agora

```bash
# 1. Rebuild da imagem (OBRIGATÓRIO)
docker build -t rabbitmq-consumer:latest .

# 2. Deploy
docker stack deploy -c docker-compose.yml consumer

# 3. Verificar logs
docker service logs consumer_consumer -f
```

## Verificação de Sucesso

Você deve ver no log:
```
Attempting to initialize SQLite at: /data/consumers.db
Database directory: /data
SQLite database initialized successfully at: /data/consumers.db
Connected to RabbitMQ
```

## Se Ainda Falhar

Execute para debug:
```bash
# Ver logs completos
docker service logs consumer_consumer --tail 100

# Verificar permissões dentro do container
docker exec -it <container_id> ls -la /data

# Verificar usuário
docker exec -it <container_id> whoami
docker exec -it <container_id> id
```

## Rollback Rápido

Se precisar voltar para versão anterior:
```bash
git checkout HEAD~1 index.js package.json Dockerfile docker-compose.yml
docker build -t rabbitmq-consumer:latest .
docker stack deploy -c docker-compose.yml consumer
```

