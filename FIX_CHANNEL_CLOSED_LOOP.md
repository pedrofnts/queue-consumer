# 🔧 FIX - Loop de "Channel Closed" e Perda de Consumers

## O Problema

Quando o RabbitMQ channel fechava durante o processamento de mensagens, você via:

```
Error processing message for queue 67: IllegalOperationError: Channel closed
Error nacking message for queue 67: IllegalOperationError: Channel closed
Processing message from queue 67: { ... }
Error processing message for queue 67: IllegalOperationError: Channel closed
Error nacking message for queue 67: IllegalOperationError: Channel closed
[loop infinito de erros]

Recreating channel only...
Channel recreated successfully
📊 Found 1 consumers in database to restore
[MAS NÃO RESTAURAVA]

Started consuming queue 67 [só quando você chamava o webhook manualmente]
```

## Por Que Acontecia?

### 1. **Callbacks Antigas Continuavam Rodando**

```javascript
// Fluxo do Bug:
1. Consumer criado → callback registrada no RabbitMQ
2. Mensagens começam a ser processadas
3. Channel fecha (erro RabbitMQ, PRECONDITION_FAILED, etc)
4. ❌ Callbacks ANTIGAS ainda estão na memória do Node.js
5. ❌ Essas callbacks continuam tentando processar mensagens
6. ❌ Tentam fazer ack/nack com channel FECHADO
7. ❌ Geram loops de "Channel closed"
```

### 2. **Race Condition na Recriação**

```javascript
// Quando channel era recriado:
1. activeConsumers.clear() → limpa consumers em memória
2. loadConsumersFromDb() → tenta restaurar do banco
3. ❌ MAS callbacks antigas ainda rodando!
4. ❌ Conflito entre consumers antigos e novos
5. ❌ Consumers não eram recriados corretamente
```

### 3. **Falta de Versionamento**

O código não tinha forma de distinguir:
- Mensagens de consumers ANTIGOS (channel fechado)
- Mensagens de consumers NOVOS (channel recriado)

Resultado: Callbacks antigas continuavam interferindo!

## A Solução: Channel Versioning

### Conceito

Cada vez que o channel é criado/recriado, incrementamos um número de versão. Callbacks antigas verificam a versão antes de fazer qualquer operação.

```javascript
class RabbitMQConsumer {
    constructor() {
        this.channelVersion = 0;  // Versão inicial
        // ...
    }
}
```

### Incremento de Versão

**Toda vez que o channel é criado/recriado:**

```javascript
// Conexão inicial
this.channel = await this.connection.createChannel();
this.channelVersion++;  // Versão 1
console.log(`Initial channel version ${this.channelVersion}`);

// Reconexão completa
this.channel = await this.connection.createChannel();
this.channelVersion++;  // Versão 2
console.log(`Created channel version ${this.channelVersion}`);

// Recriação só do channel
this.channel = await this.connection.createChannel();
this.channelVersion++;  // Versão 3
console.log(`Recreated channel version ${this.channelVersion}`);
```

### Captura de Versão no Consumer

**Quando um consumer é criado, capturamos a versão atual:**

```javascript
async startConsuming(queue, webhook, minInterval, maxInterval, businessHours) {
    // Capturar versão ANTES de criar callback
    const consumerChannelVersion = this.channelVersion;
    console.log(`Starting consumer for queue ${queue} on channel version ${consumerChannelVersion}`);

    const consumer = await this.channel.consume(queue, async (msg) => {
        // Verificar se esta callback ainda é válida
        if (consumerChannelVersion !== this.channelVersion) {
            console.log(`Ignoring message - channel version mismatch (${consumerChannelVersion} vs ${this.channelVersion})`);
            return;  // ← IGNORA mensagem de callback antiga!
        }

        // Processar mensagem...
    });

    // Armazenar versão no consumer
    this.activeConsumers.set(queue, {
        consumerTag: consumer.consumerTag,
        channelVersion: consumerChannelVersion,
        // ...
    });
}
```

### Verificação em processMessage

**Todas as operações no channel verificam a versão:**

```javascript
async processMessage(msg, queue, webhook, minInterval, maxInterval, businessHours, expectedChannelVersion) {
    // 1️⃣ Verificação inicial
    if (expectedChannelVersion !== this.channelVersion) {
        console.log(`Skipping message processing - channel version mismatch`);
        return;
    }

    // 2️⃣ Antes de NACK (pausa)
    if (consumer && consumer.paused) {
        if (this.isChannelOpen() && expectedChannelVersion === this.channelVersion) {
            this.channel.nack(msg, false, true);
        }
        return;
    }

    // 3️⃣ Antes de NACK (business hours)
    if (!this.isWithinBusinessHours(businessHours)) {
        if (this.isChannelOpen() && expectedChannelVersion === this.channelVersion) {
            this.channel.nack(msg, false, true);
        }
        return;
    }

    // 4️⃣ Antes de ACK
    await axios.post(webhook, messageContent);
    if (this.isChannelOpen() && expectedChannelVersion === this.channelVersion) {
        this.channel.ack(msg);
    } else {
        console.log(`Skipping ack - channel changed`);
        return;
    }

    // 5️⃣ Verificação contínua
    if (!this.isChannelOpen() || expectedChannelVersion !== this.channelVersion) {
        console.log(`Channel changed while processing`);
        return;
    }

    // 6️⃣ Antes de checkQueue
    const queueInfo = await this.channel.checkQueue(queue);
    if (queueInfo.messageCount === 0) {
        if (consumer && this.isChannelOpen() && expectedChannelVersion === this.channelVersion) {
            await this.channel.cancel(consumer.consumerTag);
            // ...
        }
    }

    // 7️⃣ Error handling - verificar antes de ACK/NACK
    } catch (error) {
        if (!this.isChannelOpen() || expectedChannelVersion !== this.channelVersion) {
            console.log(`Channel changed, skipping error handling`);
            return;
        }
        // só faz ack/nack se versão ainda for válida
    }
}
```

## Como Funciona Agora

### Cenário: Channel Fecha Durante Processamento

```
Estado inicial:
- channelVersion = 1
- Consumer para queue 67 (versão 1) processando mensagens

1. Mensagem 1 sendo processada (versão esperada: 1)
2. Channel fecha por PRECONDITION_FAILED
3. Sistema detecta: "Channel closed unexpectedly"
4. Recria channel → channelVersion agora é 2
5. activeConsumers.clear()
6. loadConsumersFromDb()
7. Novo consumer criado para queue 67 (versão 2)

8. Callback ANTIGA (versão 1) tenta processar:
   ✅ Verifica: 1 !== 2
   ✅ Log: "Ignoring message - channel version mismatch (1 vs 2)"
   ✅ Return (não faz nada, sem erros!)

9. Callback NOVA (versão 2) processa normalmente:
   ✅ Verifica: 2 === 2
   ✅ Processa mensagem
   ✅ Faz ack/nack normalmente
```

### Logs de Sucesso

**Ao Recriar Channel:**
```
Channel closed unexpectedly
Connection still alive, recreating channel only
Recreated channel version 2
📊 Found 1 consumers in database to restore
🔄 Consumers to restore: 67
Starting consumer for queue 67 on channel version 2
Started consuming queue 67 with webhook https://...
✅ Restored consumer for queue 67
📊 Restoration complete: 1 succeeded, 0 failed
🎉 Successfully restored consumers: 67
```

**Durante Processamento com Versão Antiga:**
```
Ignoring message from queue 67 - channel version mismatch (1 vs 2)
Skipping message processing for queue 67 - channel version mismatch
```

**Processamento Normal (Versão Correta):**
```
Processing message from queue 67: { ... }
Next message for queue 67 will be processed in 45 seconds
```

## Melhorias de Logging

### Logs Detalhados de Restauração

```javascript
📊 Found 2 consumers in database to restore
🔄 Consumers to restore: queue1, queue2
Starting consumer for queue queue1 on channel version 3
✅ Restored consumer for queue queue1
Starting consumer for queue queue2 on channel version 3
✅ Restored consumer for queue queue2
📊 Restoration complete: 2 succeeded, 0 failed
🎉 Successfully restored consumers: queue1, queue2
```

Se houver falha:
```javascript
📊 Found 2 consumers in database to restore
🔄 Consumers to restore: queue1, queue2
Starting consumer for queue queue1 on channel version 3
✅ Restored consumer for queue queue1
Starting consumer for queue queue2 on channel version 3
❌ Failed to restore consumer for queue queue2: Queue does not exist
📊 Restoration complete: 1 succeeded, 1 failed
🎉 Successfully restored consumers: queue1
```

## Comparação: Antes vs Depois

### ❌ Antes (Com Bug)

```
1. Channel fecha durante processamento
2. 🔥 100+ "Error processing message: Channel closed"
3. 🔥 100+ "Error nacking message: Channel closed"
4. Channel recriado
5. Consumers "encontrados" no banco mas não restaurados
6. ❌ Processamento para
7. ❌ Só volta a funcionar com intervenção manual
```

### ✅ Depois (Corrigido)

```
1. Channel fecha durante processamento
2. ✅ Callbacks antigas detectam versão diferente
3. ✅ "Ignoring message - channel version mismatch"
4. ✅ Silenciosamente ignora mensagens antigas (sem erros!)
5. Channel recriado (versão incrementa)
6. Consumers restaurados do banco
7. ✅ Novos consumers começam a processar imediatamente
8. ✅ Processamento continua automaticamente
```

## Benefícios

### 1. **Sem Loops de Erro**
- Callbacks antigas são ignoradas silenciosamente
- Não tentam operar em channel fechado
- Logs limpos

### 2. **Restauração Automática Confiável**
- Consumers sempre são restaurados após recrear channel
- Logs claros de sucesso/falha
- Contador de restauração

### 3. **Zero Intervenção Manual**
- Sistema se recupera sozinho
- Não precisa chamar webhook manualmente
- Resiliente a crashes

### 4. **Debugging Facilitado**
- Logs com versão do channel
- Fácil identificar callbacks antigas
- Contador de sucesso/falha na restauração

## Testes

### 1. **Teste de Channel Closing Durante Processamento**

```bash
# 1. Criar consumer
curl -X POST http://gate.iszap.com.br/consume \
  -H "Content-Type: application/json" \
  -d '{"queue":"teste","webhook":"https://webhook.site/xxx"}'

# 2. Enviar muitas mensagens para a fila (via RabbitMQ)

# 3. Forçar erro no RabbitMQ (fazer ack de delivery tag inválida, etc)

# 4. Ver logs - deve mostrar:
# - "Ignoring message - channel version mismatch"
# - "Recreated channel version X"
# - "✅ Restored consumer for queue teste"
# - Processamento continua automaticamente
```

### 2. **Teste de Múltiplos Consumers**

```bash
# Criar 3 consumers
for i in {1..3}; do
  curl -X POST http://gate.iszap.com.br/consume \
    -H "Content-Type: application/json" \
    -d "{\"queue\":\"queue$i\",\"webhook\":\"https://webhook.site/xxx\"}"
done

# Forçar restart
docker service update --force consumer_consumer

# Ver logs - deve restaurar todos os 3
# "📊 Restoration complete: 3 succeeded, 0 failed"
```

## Deploy

```bash
# 1. Rebuild
docker build -t rabbitmq-consumer:latest .

# 2. Deploy
docker service update --image rabbitmq-consumer:latest consumer_consumer

# 3. Verificar logs
docker service logs consumer_consumer -f
```

Procure por:
- `Initial channel version 1`
- `Starting consumer for queue X on channel version 1`
- Se houver recreação: `Recreated channel version 2`
- Restauração: `📊 Restoration complete: X succeeded, Y failed`

## Conclusão

O problema **não era falta de restauração**, era **interferência de callbacks antigas** que continuavam rodando após o channel fechar, causando:
1. Loops infinitos de erros
2. Conflitos na recriação de consumers
3. Consumers não sendo restaurados

A solução com **versionamento de channel** garante que:
1. Callbacks antigas são ignoradas silenciosamente
2. Só callbacks da versão atual operam no channel
3. Consumers são restaurados automaticamente e funcionam imediatamente
4. Sistema é auto-recovery sem intervenção manual

🎉 **Problema resolvido!**

