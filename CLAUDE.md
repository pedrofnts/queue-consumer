# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

This is a RabbitMQ consumer service with an Express API for managing queue consumption. It processes messages from RabbitMQ queues and forwards them to webhooks with configurable intervals and business hours constraints.

## Development Commands

### Running the Service
```bash
node index.js
```

### Using Docker
```bash
# Build the image
docker build -t rabbitmq-consumer .

# Run the container
docker run -e RABBITMQ_URL=<url> -e FINISH_WEBHOOK=<webhook> -p 3000:3000 rabbitmq-consumer
```

### Dependencies
```bash
npm install
```

## Environment Variables

Required environment variables:
- `RABBITMQ_URL`: RabbitMQ connection URL (required)
- `FINISH_WEBHOOK`: Webhook URL called when a queue is emptied (required)
- `REDIS_URL`: Redis connection URL for persistence (default: redis://localhost:6379)
- `API_PORT`: API server port (default: 3000)
- `MAX_RECONNECT_ATTEMPTS`: Maximum reconnection attempts before forcing container restart (default: 10)

## Architecture

### Core Design Pattern

The service uses a single-class architecture (`RabbitMQConsumer`) that manages:
1. RabbitMQ connection and channel lifecycle
2. Redis connection for consumer configuration persistence
3. Express API server for queue management
4. Multiple concurrent queue consumers with individual configurations
5. Message processing with interval-based throttling
6. Automatic restoration of consumers after restart

### Key Components

**Connection Management** (index.js:383-408)
- Single RabbitMQ connection with one channel shared across all consumers
- Graceful shutdown handling via SIGINT/SIGTERM
- Channel event handlers for errors and consumer cancellations

**Consumer Lifecycle** (index.js:267-306)
- Each queue consumer is tracked in `activeConsumers` Map with:
  - `consumerTag`: RabbitMQ consumer identifier
  - `webhook`: Target URL for forwarding messages
  - `minInterval/maxInterval`: Random delay range between messages (milliseconds)
  - `businessHours`: Object with `start` and `end` hour constraints
  - `paused`: Boolean for temporary suspension
  - `lastMessage`: Last processed message content
- Consumers auto-remove when queues are empty
- Prefetch set to 1 to process one message at a time per queue

**Message Processing Flow** (index.js:329-381)
1. Check if consumer is paused → nack and return if true
2. Validate business hours (America/Sao_Paulo timezone) → nack if outside hours
3. Parse message content as JSON
4. POST to configured webhook
5. ACK on success or webhook error (4xx/5xx)
6. NACK and requeue on parsing/network errors
7. Check if queue is empty → auto-stop consumer and notify via FINISH_WEBHOOK
8. Otherwise, set random interval for next message

**Business Hours Logic** (index.js:312-316)
- Uses `date-fns-tz` with America/Sao_Paulo timezone
- Compares current hour against configured start/end range
- Messages outside business hours are nack'd and requeued

**Interval Management** (index.js:308-310)
- Each queue has a random interval calculated between min/max values
- Interval regenerates after each successful message processing
- Applied before processing next message from the queue

### API Endpoints

All endpoints are defined in `setupAPI()` (index.js:69-265):

- `GET /health` - Health check (200 if channel connected, 503 otherwise)
- `POST /consume` - Start consuming a queue with configuration
- `GET /active-queues` - List all active consumers with queue estimates
- `GET /queue-info/:queue` - Get info for a specific queue
- `POST /queues-info` - Batch queue information (accepts array of queue names)
- `POST /pause` - Temporarily pause a queue consumer
- `POST /resume` - Resume a paused queue consumer
- `POST /stop` - Permanently stop a queue consumer and notify webhook

### Important Behaviors

**Queue Completion Notification**
When a queue becomes empty or consumer is stopped, the service POSTs to FINISH_WEBHOOK with:
```json
{
  "queue": "queue-name",
  "lastMessage": { /* last processed message content */ }
}
```

**Error Handling Strategy**
- Webhook errors (4xx/5xx responses): Message is ACK'd and discarded
- Network/timeout errors: Message is NACK'd and requeued
- JSON parsing errors: Message is NACK'd and requeued

**Time Estimation** (index.js:22-67)
The `/active-queues` endpoint calculates completion estimates based on:
- Current message count in queue
- Average of min/max interval
- Does NOT account for business hours or paused state

## Code Patterns

**State Management**
- `activeConsumers`: Map of queue name → consumer configuration
- `queueIntervals`: Object mapping queue name → next interval duration
- `lastSend`: Object tracking last send timestamp per queue (written but not actively used)

**Timezone Handling**
All time operations use America/Sao_Paulo timezone via `date-fns-tz`:
- `utcToZonedTime()`: Convert current time to local timezone
- `format()`: Extract hour in 24-hour format

**Input Validation**
Queue names must be:
- Present (non-null/undefined)
- String type
- Non-empty after trimming

Webhook URLs must:
- Start with "http"

## Persistence with Redis

**Consumer State Persistence** (index.js:45-127)
The service persists consumer configurations in Redis to survive container restarts:

**Data Structure:**
Each consumer is stored as a Redis hash at key `consumer:{queue}` with fields:
- `webhook`: Target webhook URL
- `minInterval`: Minimum interval in milliseconds
- `maxInterval`: Maximum interval in milliseconds
- `businessHoursStart`: Start hour (0-23)
- `businessHoursEnd`: End hour (0-23)
- `paused`: Boolean state ("true"/"false")

**Persistence Operations:**
- `saveConsumerToRedis()`: Saves consumer config when started via POST /consume
- `deleteConsumerFromRedis()`: Removes config when stopped via POST /stop
- `updateConsumerPausedState()`: Updates paused state via POST /pause and /resume
- `loadConsumersFromRedis()`: Restores all consumers on service startup

**Automatic Recovery:**
On service start, after RabbitMQ connection:
1. Scans Redis for all `consumer:*` keys
2. For each saved consumer, attempts to recreate the RabbitMQ consumer
3. If queue no longer exists in RabbitMQ, removes the stale config from Redis
4. Restores paused state if applicable

**Automatic Reconnection System** (index.js:131-248)
The service has a robust multi-level reconnection strategy:

**Connection/Channel Error Handling:**
1. When a channel error occurs, checks if the connection is still alive
2. If connection is alive → recreates only the channel (faster recovery)
3. If connection is lost → performs full reconnection (connection + channel)
4. Both connection and channel have event handlers for `error` and `close` events

**Reconnection Attempts:**
- Tracks consecutive reconnection attempts with `reconnectAttempts` counter
- Resets counter to 0 after successful reconnection
- If reconnection fails `MAX_RECONNECT_ATTEMPTS` times (default: 10):
  - Logs failure message
  - Gracefully closes all resources (channel, connection, Redis)
  - Exits process with code 1
  - Docker/Kubernetes will automatically restart the container
  - On restart, consumers are restored from Redis

**Recovery Timeline:**
- Channel-only recreation: 2 second retry interval
- Full reconnection: 5 second retry interval
- After each successful reconnection, all consumers are restored from Redis

**Why Force Restart:**
In extreme cases where reconnection consistently fails (e.g., network issues, RabbitMQ cluster changes, corrupted state), forcing a container restart provides a clean slate while maintaining consumer configurations via Redis persistence.
