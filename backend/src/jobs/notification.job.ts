import { Queue, Worker, Job, ConnectionOptions } from 'bullmq';
import { PrismaClient } from '@prisma/client';
import { WhatsAppAdapter } from '../services/outputs/whatsapp.adapter';
import { logger } from '../utils/logger';

const prisma = new PrismaClient();

const getRedisConnectionOptions = (): ConnectionOptions => {
  const urlStr = process.env.REDIS_URL || 'redis://localhost:6379/0';
  try {
    const parsed = new URL(urlStr);
    return {
      host: parsed.hostname || 'localhost',
      port: parsed.port ? parseInt(parsed.port, 10) : 6379,
      username: parsed.username || undefined,
      password: parsed.password || undefined,
      db: parsed.pathname ? parseInt(parsed.pathname.substring(1) || '0', 10) : 0,
      maxRetriesPerRequest: null,
      tls: parsed.protocol === 'rediss:' ? { rejectUnauthorized: false } : undefined,
    };
  } catch (error) {
    logger.error('Failed to parse REDIS_URL for notifications, falling back to localhost:', error);
    return {
      host: 'localhost',
      port: 6379,
      maxRetriesPerRequest: null,
    };
  }
};

const connection = getRedisConnectionOptions();

export const notificationQueue = new Queue('notificationQueue', { 
  connection,
  defaultJobOptions: {
    attempts: 5,
    backoff: {
      type: 'exponential',
      delay: 2000, // 2s, 4s, 8s, 16s...
    }
  }
});

export const notificationWorker = new Worker(
  'notificationQueue',
  async (job: Job) => {
    const { userId, emailSummary, channel } = job.data;
    logger.info(`[BullMQ Worker] Executing notification job ${job.id} for user: ${userId}, channel: ${channel}`);

    if (channel === 'whatsapp') {
      const adapter = new WhatsAppAdapter();
      // sendNotification handles the DB logging and actual API call
      // If it throws an error (e.g., rate limit), BullMQ will automatically retry with exponential backoff
      await adapter.sendNotification(userId, emailSummary);
    }
  },
  { connection }
);

notificationWorker.on('completed', (job) => {
  logger.info(`[BullMQ] Notification Job ${job.id} completed successfully.`);
});

notificationWorker.on('failed', (job, err) => {
  logger.error(`[BullMQ] Notification Job ${job?.id} failed with error:`, err);
});
