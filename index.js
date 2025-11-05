const amqp = require('amqplib');
const axios = require('axios');
const express = require('express');
const { zonedTimeToUtc, utcToZonedTime, format } = require('date-fns-tz');
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const RABBITMQ_URL = process.env.RABBITMQ_URL;
const API_PORT = process.env.API_PORT || 3000;
const TIMEZONE = 'America/Sao_Paulo';
const FINISH_WEBHOOK = process.env.FINISH_WEBHOOK;
const DB_PATH = process.env.DB_PATH || '/data/consumers.db';
const MAX_RECONNECT_ATTEMPTS = parseInt(process.env.MAX_RECONNECT_ATTEMPTS) || 10;

class RabbitMQConsumer {
    constructor() {
        this.lastSend = {};
        this.connection = null;
        this.channel = null;
        this.queueIntervals = {};
        this.activeConsumers = new Map();
        this.isReconnecting = false;
        this.reconnectAttempts = 0;
        this.lastSuccessfulConnection = Date.now();
        
        try {
            // Garantir que o diretório existe
            const dbDir = path.dirname(DB_PATH);
            if (!fs.existsSync(dbDir)) {
                fs.mkdirSync(dbDir, { recursive: true });
            }

            // Inicializar SQLite
            this.db = new Database(DB_PATH);
            this.db.pragma('journal_mode = WAL');
            
            // Criar tabela se não existir
            this.db.exec(`
                CREATE TABLE IF NOT EXISTS consumers (
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
            `);

            console.log('SQLite database initialized at:', DB_PATH);
        } catch (error) {
            console.error('CRITICAL: Failed to initialize SQLite database:', error);
            console.error('Exiting process to force restart...');
            process.exit(1);
        }

        this.setupAPI();
    }

    isChannelOpen() {
        return this.channel && !this.channel.closing && !this.channel.closed;
    }

    saveConsumerToDb(queue, webhook, minInterval, maxInterval, businessHours, paused = false) {
        try {
            const stmt = this.db.prepare(`
                INSERT OR REPLACE INTO consumers 
                (queue, webhook, minInterval, maxInterval, businessHoursStart, businessHoursEnd, paused, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
            `);
            
            stmt.run(
                queue,
                webhook,
                minInterval,
                maxInterval,
                businessHours.start,
                businessHours.end,
                paused ? 1 : 0
            );
            
            console.log(`Saved consumer config for queue ${queue} to database`);
        } catch (error) {
            console.error(`CRITICAL: Failed to save consumer to database for queue ${queue}:`, error);
            console.error('Database write failure - exiting to force restart...');
            process.exit(1);
        }
    }

    deleteConsumerFromDb(queue) {
        try {
            const stmt = this.db.prepare('DELETE FROM consumers WHERE queue = ?');
            stmt.run(queue);
            console.log(`Deleted consumer config for queue ${queue} from database`);
        } catch (error) {
            console.error(`CRITICAL: Failed to delete consumer from database for queue ${queue}:`, error);
            console.error('Database write failure - exiting to force restart...');
            process.exit(1);
        }
    }

    updateConsumerPausedState(queue, paused) {
        try {
            const stmt = this.db.prepare(`
                UPDATE consumers 
                SET paused = ?, updated_at = CURRENT_TIMESTAMP 
                WHERE queue = ?
            `);
            stmt.run(paused ? 1 : 0, queue);
            console.log(`Updated paused state for queue ${queue} to ${paused}`);
        } catch (error) {
            console.error(`CRITICAL: Failed to update paused state in database for queue ${queue}:`, error);
            console.error('Database write failure - exiting to force restart...');
            process.exit(1);
        }
    }

    async loadConsumersFromDb() {
        try {
            const stmt = this.db.prepare('SELECT * FROM consumers');
            const consumers = stmt.all();
            
            console.log(`Found ${consumers.length} consumers in database to restore`);

            for (const config of consumers) {
                if (!config.webhook) {
                    console.log(`Invalid config for ${config.queue}, skipping`);
                    continue;
                }

                const businessHours = {
                    start: config.businessHoursStart,
                    end: config.businessHoursEnd
                };

                const paused = config.paused === 1;

                try {
                    await this.startConsuming(
                        config.queue,
                        config.webhook,
                        config.minInterval,
                        config.maxInterval,
                        businessHours
                    );

                    // Restaurar estado pausado IMEDIATAMENTE
                    const consumer = this.activeConsumers.get(config.queue);
                    if (consumer) {
                        consumer.paused = paused;
                    }

                    console.log(`Restored consumer for queue ${config.queue}${paused ? ' (paused)' : ''}`);
                } catch (error) {
                    console.error(`Failed to restore consumer for queue ${config.queue}:`, error.message);
                    // Se a fila não existe mais, remove do banco
                    if (error.message.includes('does not exist')) {
                        this.deleteConsumerFromDb(config.queue);
                    }
                }
            }
        } catch (error) {
            console.error('CRITICAL: Error loading consumers from database:', error);
            console.error('Database read failure - exiting to force restart...');
            process.exit(1);
        }
    }

    async reconnect() {
        if (this.isReconnecting) {
            console.log('Reconnection already in progress');
            return;
        }

        this.isReconnecting = true;
        this.reconnectAttempts++;

        console.log(`Reconnecting to RabbitMQ... (attempt ${this.reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS})`);

        // Verificar se atingiu o limite de tentativas
        if (this.reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
            console.error(`Failed to reconnect after ${MAX_RECONNECT_ATTEMPTS} attempts`);
            console.log('Forcing container restart by exiting process...');

            // Fechar recursos antes de sair
            try {
                if (this.channel) await this.channel.close();
                if (this.connection) await this.connection.close();
                if (this.db) this.db.close();
            } catch (err) {
                console.error('Error closing resources:', err);
            }

            // Exit com código 1 para sinalizar erro - o Docker/Kubernetes vai reiniciar o container
            process.exit(1);
        }

        // Salvar consumers ativos antes de limpar
        const consumersToRestore = new Map(this.activeConsumers);

        try {
            // Fechar conexão e channel existentes
            if (this.channel) {
                try {
                    await this.channel.close();
                } catch (err) {
                    console.log('Channel already closed');
                }
            }

            if (this.connection) {
                try {
                    await this.connection.close();
                } catch (err) {
                    console.log('Connection already closed');
                }
            }

            // Criar nova conexão
            this.connection = await amqp.connect(RABBITMQ_URL);

            // Handlers da conexão
            this.connection.on('error', (err) => {
                console.error('Connection error:', err);
                // Não chamar reconnect aqui, deixar o event close fazer isso
            });

            this.connection.on('close', () => {
                console.log('Connection closed, will reconnect');
                setTimeout(() => this.reconnect(), 5000);
            });

            // Criar novo channel
            this.channel = await this.connection.createChannel();
            await this.channel.prefetch(1);

            // Handlers do channel
            this.channel.on('error', (err) => {
                console.error('Channel error:', err);
                // Não chamar reconnect aqui, deixar o event close fazer isso
            });

            this.channel.on('close', () => {
                console.log('Channel closed unexpectedly');
                // Se a conexão ainda está viva, tentar recriar só o channel
                if (this.connection && !this.connection.connection.stream.destroyed) {
                    console.log('Connection still alive, recreating channel only');
                    this.recreateChannelOnly();
                } else {
                    console.log('Connection lost, full reconnect needed');
                    setTimeout(() => this.reconnect(), 5000);
                }
            });

            this.channel.on('cancel', async (consumerTag) => {
                for (const [queue, data] of this.activeConsumers.entries()) {
                    if (data.consumerTag === consumerTag) {
                        await this.notifyQueueFinish(queue, data.lastMessage);
                        console.log(`Queue ${queue} was deleted or cancelled`);
                        this.activeConsumers.delete(queue);
                        await this.deleteConsumerFromDb(queue);
                        break;
                    }
                }
            });

            console.log('Reconnected to RabbitMQ successfully');

            // Reset do contador após reconexão bem-sucedida
            this.reconnectAttempts = 0;
            this.lastSuccessfulConnection = Date.now();

            // Limpar antes de recriar
            this.activeConsumers.clear();

            // Restaurar consumers salvos no banco
            await this.loadConsumersFromDb();

        } catch (error) {
            console.error('Error during reconnection:', error);
            console.log('Retrying reconnection in 5 seconds...');
            setTimeout(() => this.reconnect(), 5000);
        } finally {
            this.isReconnecting = false;
        }
    }

    async recreateChannelOnly() {
        if (this.isReconnecting) {
            console.log('Channel recreation already in progress');
            return;
        }

        this.isReconnecting = true;
        console.log('Recreating channel only...');

        try {
            if (this.channel) {
                try {
                    await this.channel.close();
                } catch (err) {
                    console.log('Channel already closed');
                }
            }

            this.channel = await this.connection.createChannel();
            await this.channel.prefetch(1);

            // Handlers do channel
            this.channel.on('error', (err) => {
                console.error('Channel error:', err);
            });

            this.channel.on('close', () => {
                console.log('Channel closed unexpectedly');
                if (this.connection && !this.connection.connection.stream.destroyed) {
                    console.log('Connection still alive, recreating channel only');
                    setTimeout(() => this.recreateChannelOnly(), 2000);
                } else {
                    console.log('Connection lost, full reconnect needed');
                    setTimeout(() => this.reconnect(), 5000);
                }
            });

            this.channel.on('cancel', async (consumerTag) => {
                for (const [queue, data] of this.activeConsumers.entries()) {
                    if (data.consumerTag === consumerTag) {
                        await this.notifyQueueFinish(queue, data.lastMessage);
                        console.log(`Queue ${queue} was deleted or cancelled`);
                        this.activeConsumers.delete(queue);
                        await this.deleteConsumerFromDb(queue);
                        break;
                    }
                }
            });

            console.log('Channel recreated successfully');

            // Limpar antes de recriar
            this.activeConsumers.clear();

            // Restaurar consumers do banco
            await this.loadConsumersFromDb();

        } catch (error) {
            console.error('Error recreating channel:', error);
            // Se falhar em recriar o channel, provavelmente a conexão está ruim
            console.log('Channel recreation failed, attempting full reconnect...');
            setTimeout(() => this.reconnect(), 5000);
        } finally {
            this.isReconnecting = false;
        }
    }

    async calculateQueueEstimates(queue, data) {
        try {
            if (!this.isChannelOpen()) {
                throw new Error('Channel is closed');
            }

            const queueInfo = await this.channel.checkQueue(queue);
            const messageCount = queueInfo.messageCount;
            const avgInterval = (data.minInterval + data.maxInterval) / 2;

            const estimatedTimeMs = messageCount * avgInterval;

            const hours = Math.floor(estimatedTimeMs / (1000 * 60 * 60));
            const minutes = Math.floor((estimatedTimeMs % (1000 * 60 * 60)) / (1000 * 60));
            const seconds = Math.floor((estimatedTimeMs % (1000 * 60)) / 1000);

            return {
                queue,
                webhook: data.webhook,
                minInterval: data.minInterval,
                maxInterval: data.maxInterval,
                businessHours: data.businessHours,
                paused: data.paused,
                currentStats: {
                    messageCount,
                    avgIntervalSeconds: avgInterval / 1000,
                    estimatedCompletion: {
                        rawEstimateMs: estimatedTimeMs,
                        formatted: `${hours}h ${minutes}m ${seconds}s`,
                        hours,
                        minutes,
                        seconds
                    }
                }
            };
        } catch (error) {
            console.error(`Error getting queue info for ${queue}:`, error);
            return {
                queue,
                webhook: data.webhook,
                minInterval: data.minInterval,
                maxInterval: data.maxInterval,
                businessHours: data.businessHours,
                paused: data.paused,
                currentStats: {
                    error: 'Could not get queue information'
                }
            };
        }
    }

    setupAPI() {
        const app = express();
        app.use(express.json());

        app.get('/health', (req, res) => {
            if (this.channel && this.connection) {
                res.status(200).json({ status: 'healthy' });
            } else {
                res.status(503).json({ status: 'unhealthy' });
            }
        });

        app.post('/consume', async (req, res) => {
            const { 
                queue, 
                webhook,
                minInterval = 30000,
                maxInterval = 110000,
                businessHours = { start: 8, end: 21 }
            } = req.body;
            
            if (!queue || typeof queue !== 'string' || queue.trim() === '') {
                return res.status(400).json({ error: 'Queue name is required and must be a non-empty string.' });
            }

            if (!webhook || !webhook.startsWith('http')) {
                return res.status(400).json({ error: 'Invalid webhook URL' });
            }

            try {
                if (this.activeConsumers.has(queue)) {
                    return res.status(400).json({ error: 'Queue is already being consumed' });
                }

                await this.startConsuming(queue, webhook, minInterval, maxInterval, businessHours);
                await this.saveConsumerToDb(queue, webhook, minInterval, maxInterval, businessHours);

                res.json({
                    message: `Started consuming queue ${queue}`,
                    config: {
                        minInterval,
                        maxInterval,
                        businessHours
                    }
                });
            } catch (error) {
                res.status(500).json({ error: error.message });
            }
        });

        app.get('/active-queues', async (req, res) => {
            try {
                const activeQueues = await Promise.all(
                    Array.from(this.activeConsumers.entries()).map(
                        async ([queue, data]) => this.calculateQueueEstimates(queue, data)
                    )
                );
                res.json({ activeQueues });
            } catch (error) {
                res.status(500).json({ error: error.message });
            }
        });

        app.get('/queue-info/:queue', async (req, res) => {
            const { queue } = req.params;
            
            if (!queue || typeof queue !== 'string' || queue.trim() === '') {
                return res.status(400).json({ error: 'Queue name is required and must be a non-empty string.' });
            }

            try {
                const queueInfo = await this.channel.checkQueue(queue);
                res.json({
                    queue,
                    messageCount: queueInfo.messageCount,
                    consumerCount: queueInfo.consumerCount,
                    isActive: this.activeConsumers.has(queue)
                });
            } catch (error) {
                if (error.code === 404) {
                    res.status(404).json({ error: 'Queue not found' });
                } else {
                    res.status(500).json({ error: error.message });
                }
            }
        });

        app.post('/queues-info', async (req, res) => {
            const { queues } = req.body;
            
            if (!Array.isArray(queues)) {
                return res.status(400).json({ error: 'Queues must be an array' });
            }

            try {
                const queuesInfo = await Promise.all(
                    queues.map(async (queue) => {
                        try {
                            const queueInfo = await this.channel.checkQueue(queue);
                            return {
                                queue,
                                messageCount: queueInfo.messageCount,
                                consumerCount: queueInfo.consumerCount,
                                isActive: this.activeConsumers.has(queue),
                                error: null
                            };
                        } catch (error) {
                            return {
                                queue,
                                messageCount: null,
                                consumerCount: null,
                                isActive: this.activeConsumers.has(queue),
                                error: error.code === 404 ? 'Queue not found' : error.message
                            };
                        }
                    })
                );

                res.json({ queues: queuesInfo });
            } catch (error) {
                res.status(500).json({ error: error.message });
            }
        });

        app.post('/pause', async (req, res) => {
            const { queue } = req.body;
            
            if (!queue || typeof queue !== 'string' || queue.trim() === '') {
                return res.status(400).json({ error: 'Queue name is required and must be a non-empty string.' });
            }

            try {
                const consumer = this.activeConsumers.get(queue);
                if (!consumer) {
                    return res.status(404).json({ error: 'Queue is not being consumed' });
                }

                if (consumer.paused) {
                    return res.status(400).json({ error: 'Queue is already paused' });
                }

                consumer.paused = true;
                await this.updateConsumerPausedState(queue, true);
                res.json({ message: `Queue ${queue} has been paused` });
            } catch (error) {
                res.status(500).json({ error: error.message });
            }
        });

        app.post('/resume', async (req, res) => {
            const { queue } = req.body;
            
            if (!queue || typeof queue !== 'string' || queue.trim() === '') {
                return res.status(400).json({ error: 'Queue name is required and must be a non-empty string.' });
            }

            try {
                const consumer = this.activeConsumers.get(queue);
                if (!consumer) {
                    return res.status(404).json({ error: 'Queue is not being consumed' });
                }

                if (!consumer.paused) {
                    return res.status(400).json({ error: 'Queue is not paused' });
                }

                consumer.paused = false;
                await this.updateConsumerPausedState(queue, false);
                res.json({ message: `Queue ${queue} has been resumed` });
            } catch (error) {
                res.status(500).json({ error: error.message });
            }
        });

        app.post('/stop', async (req, res) => {
            const { queue } = req.body;
            
            if (!queue || typeof queue !== 'string' || queue.trim() === '') {
                return res.status(400).json({ error: 'Queue name is required and must be a non-empty string.' });
            }

            try {
                const consumer = this.activeConsumers.get(queue);
                if (!consumer) {
                    return res.status(404).json({ error: 'Queue is not being consumed' });
                }

                await this.channel.cancel(consumer.consumerTag);
                await this.notifyQueueFinish(queue, consumer.lastMessage);
                this.activeConsumers.delete(queue);
                await this.deleteConsumerFromDb(queue);

                res.json({ message: `Queue ${queue} consumption has been stopped` });
            } catch (error) {
                res.status(500).json({ error: error.message });
            }
        });

        app.listen(API_PORT, () => {
            console.log(`API server listening on port ${API_PORT}`);
        });
    }

    async startConsuming(queue, webhook, minInterval, maxInterval, businessHours) {
        if (!this.channel) {
            throw new Error('Not connected to RabbitMQ');
        }

        try {
            await this.channel.checkQueue(queue);
            await this.channel.prefetch(1);

            const consumer = await this.channel.consume(queue, async (msg) => {
                if (msg === null) {
                    this.activeConsumers.delete(queue);
                    return;
                }

                try {
                    await new Promise(resolve => setTimeout(resolve, this.queueIntervals[queue] || this.getRandomInterval(minInterval, maxInterval)));
                    await this.processMessage(msg, queue, webhook, minInterval, maxInterval, businessHours);
                } catch (error) {
                    console.error(`Error processing message from queue ${queue}:`, error);
                    if (this.isChannelOpen()) {
                        try {
                            this.channel.nack(msg, false, true);
                        } catch (nackError) {
                            console.error(`Error nacking message:`, nackError);
                        }
                    }
                }
            });

            this.activeConsumers.set(queue, {
                consumerTag: consumer.consumerTag,
                webhook,
                minInterval,
                maxInterval,
                businessHours,
                lastMessage: null,
                paused: false
            });

            this.queueIntervals[queue] = this.getRandomInterval(minInterval, maxInterval);
            console.log(`Started consuming queue ${queue} with webhook ${webhook}`);
        } catch (error) {
            throw new Error(`Queue ${queue} does not exist`);
        }
    }

    getRandomInterval(minInterval, maxInterval) {
        return Math.floor(Math.random() * (maxInterval - minInterval + 1) + minInterval);
    }

    isWithinBusinessHours(businessHours) {
        const localTime = utcToZonedTime(new Date(), TIMEZONE);
        const hour = parseInt(format(localTime, 'H', { timeZone: TIMEZONE }));
        return hour >= businessHours.start && hour < businessHours.end;
    }



    async notifyQueueFinish(queue, lastMessage) {
        try {
            await axios.post(FINISH_WEBHOOK, { queue, lastMessage });
            console.log(`Notified queue completion for ${queue}`);
        } catch (error) {
            console.error(`Error notifying queue completion for ${queue}:`, error);
        }
    }

    async processMessage(msg, queue, webhook, minInterval, maxInterval, businessHours) {
        if (!msg) return;

        if (!this.isChannelOpen()) {
            console.log(`Channel is closed, cannot process message from queue ${queue}`);
            return;
        }

        const consumer = this.activeConsumers.get(queue);
        if (consumer && consumer.paused) {
            if (this.isChannelOpen()) {
                this.channel.nack(msg, false, true);
                console.log(`Queue ${queue} is paused, message returned to queue`);
            }
            return;
        }

        if (!this.isWithinBusinessHours(businessHours)) {
            if (this.isChannelOpen()) {
                this.channel.nack(msg, false, true);
                console.log(`Outside business hours (${businessHours.start}-${businessHours.end}), message returned to queue ${queue}`);
            }
            return;
        }

        try {
            const messageContent = JSON.parse(msg.content.toString());
            console.log(`Processing message from queue ${queue}:`, messageContent);

            await axios.post(webhook, messageContent);

            if (this.isChannelOpen()) {
                this.channel.ack(msg);
            }

            if (consumer) {
                consumer.lastMessage = messageContent;
            }

            if (!this.isChannelOpen()) {
                console.log(`Channel closed while processing queue ${queue}`);
                return;
            }

            const queueInfo = await this.channel.checkQueue(queue);
            if (queueInfo.messageCount === 0) {
                if (consumer && this.isChannelOpen()) {
                    await this.channel.cancel(consumer.consumerTag);
                    await this.notifyQueueFinish(queue, consumer.lastMessage);
                    this.activeConsumers.delete(queue);
                    this.deleteConsumerFromDb(queue);  // FIX: Remover do banco quando fila termina
                    console.log(`Queue ${queue} is empty, consumer removed`);
                }
            } else {
                this.lastSend[queue] = Date.now();
                this.queueIntervals[queue] = this.getRandomInterval(minInterval, maxInterval);
                console.log(`Next message for queue ${queue} will be processed in ${this.queueIntervals[queue]/1000} seconds`);
            }

        } catch (error) {
            console.error(`Error processing message for queue ${queue}:`, error);

            if (!this.isChannelOpen()) {
                console.log(`Channel closed, cannot ack/nack message from queue ${queue}`);
                this.activeConsumers.delete(queue);
                return;
            }

            if (error.response) {
                console.log(`Webhook error, discarding message for queue ${queue}`);
                this.channel.ack(msg);
            } else if (error.code === 404 && error.message.includes('no queue')) {
                console.log(`Queue ${queue} was deleted, removing consumer`);
                this.activeConsumers.delete(queue);
            } else {
                try {
                    this.channel.nack(msg, false, true);
                } catch (nackError) {
                    console.error(`Error nacking message for queue ${queue}:`, nackError);
                }
            }
        }
    }

    async connect() {
        try {
            this.connection = await amqp.connect(RABBITMQ_URL);

            // Handlers da conexão
            this.connection.on('error', (err) => {
                console.error('Connection error:', err);
                // Não chamar reconnect aqui, deixar o event close fazer isso
            });

            this.connection.on('close', () => {
                console.log('Connection closed unexpectedly, will reconnect');
                setTimeout(() => this.reconnect(), 5000);
            });

            // Criar channel
            this.channel = await this.connection.createChannel();
            await this.channel.prefetch(1);

            // Handlers do channel
            this.channel.on('error', (err) => {
                console.error('Channel error:', err);
                // Não chamar reconnect aqui, deixar o event close fazer isso
            });

            this.channel.on('close', () => {
                console.log('Channel closed unexpectedly');
                // Se a conexão ainda está viva, tentar recriar só o channel
                if (this.connection && !this.connection.connection.stream.destroyed) {
                    console.log('Connection still alive, recreating channel only');
                    this.recreateChannelOnly();
                } else {
                    console.log('Connection lost, full reconnect needed');
                    setTimeout(() => this.reconnect(), 5000);
                }
            });

            this.channel.on('cancel', async (consumerTag) => {
                for (const [queue, data] of this.activeConsumers.entries()) {
                    if (data.consumerTag === consumerTag) {
                        await this.notifyQueueFinish(queue, data.lastMessage);
                        console.log(`Queue ${queue} was deleted or cancelled`);
                        this.activeConsumers.delete(queue);
                        await this.deleteConsumerFromDb(queue);
                        break;
                    }
                }
            });

            console.log('Connected to RabbitMQ');
        } catch (error) {
            console.error('Initial connection error:', error);
            console.log('Retrying initial connection in 5 seconds...');
            setTimeout(() => this.connect(), 5000);
        }
    }

    async handleShutdown() {
        console.log('Shutting down gracefully...');

        if (this.channel) {
            await this.channel.close();
        }
        if (this.connection) {
            await this.connection.close();
        }
        if (this.db) {
            this.db.close();
        }
        process.exit(0);
    }

    async start() {
        if (!RABBITMQ_URL) {
            console.error('RABBITMQ_URL environment variable is required');
            process.exit(1);
        }

        if (!FINISH_WEBHOOK) {
            console.error('FINISH_WEBHOOK environment variable is required');
            process.exit(1);
        }

        await this.connect();

        // Restaurar consumers salvos no banco
        await this.loadConsumersFromDb();

        process.on('SIGINT', this.handleShutdown.bind(this));
        process.on('SIGTERM', this.handleShutdown.bind(this));
    }
}

const consumer = new RabbitMQConsumer();
consumer.start().catch(error => {
    console.error('Fatal error:', error);
    process.exit(1);
});

