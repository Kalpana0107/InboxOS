import { Queue, Worker, Job } from 'bullmq';
import { PrismaClient } from '@prisma/client';
import Redis from 'ioredis';
import * as dotenv from 'dotenv';
import * as path from 'path';
import { logger } from '../../utils/logger';
import { TelegramNotificationService } from '../telegram-notification.service';

dotenv.config({ path: path.resolve(__dirname, '../../../.env') });

const prisma = new PrismaClient();

const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379/0';

/**
 * Default reminder offsets in minutes before the deadline.
 * [1440 = 24h before, 60 = 1h before, 0 = at deadline]
 */
const DEFAULT_OFFSETS_MINUTES = [1440, 60, 0];

const QUEUE_NAME = 'inboxos-reminders';

export interface ReminderFirePayload {
  reminderId: string;
  emailId: string;
  userId: string;
  deadline: string; // ISO string UTC
  offsetMinutes: number;
  isOverdue: boolean;
}

export class ReminderSchedulerService {
  private static redisClient: Redis | null = null;
  private static reminderQueue: Queue | null = null;
  private static reminderWorker: Worker | null = null;
  private static useInMemory = false;

  // ──────────────────────────────────────────────────────────────────────────
  // Redis / Queue initialization
  // ──────────────────────────────────────────────────────────────────────────

  private static getRedisClient(): Redis | null {
    if (this.useInMemory) return null;
    if (!this.redisClient) {
      this.redisClient = new Redis(REDIS_URL, {
        maxRetriesPerRequest: null,
        retryStrategy: (times) => {
          if (times > 2) {
            logger.warn(
              '[ReminderScheduler] Redis unavailable — reminders will not be persisted via BullMQ.'
            );
            this.useInMemory = true;
            return null;
          }
          return 500;
        },
      });

      this.redisClient.on('error', (err: any) => {
        if (err.code === 'ECONNREFUSED') {
          this.useInMemory = true;
        }
      });
    }
    return this.redisClient;
  }

  public static getQueue(): Queue | null {
    if (this.useInMemory) return null;
    if (!this.reminderQueue) {
      const client = this.getRedisClient();
      if (!client) return null;
      this.reminderQueue = new Queue(QUEUE_NAME, {
        connection: client as any,
        defaultJobOptions: {
          attempts: 3,
          backoff: { type: 'exponential', delay: 5000 },
          removeOnComplete: 100,
          removeOnFail: 500,
        },
      });
    }
    return this.reminderQueue;
  }

  /**
   * Initializes the BullMQ worker that processes reminder.fire jobs.
   * Call this once at server startup.
   */
  public static initWorker(): void {
    if (this.reminderWorker) return;
    const client = this.getRedisClient();
    if (!client) {
      logger.warn('[ReminderScheduler] No Redis — worker not started.');
      return;
    }

    this.reminderWorker = new Worker(
      QUEUE_NAME,
      async (job: Job) => {
        if (job.name === 'reminder.fire') {
          await this.fireReminder(job.data as ReminderFirePayload);
        }
      },
      { connection: client as any, concurrency: 10 }
    );

    this.reminderWorker.on('failed', (job: any, err: Error) => {
      logger.error(
        `[ReminderScheduler] Job ${job?.id} failed: ${err.message}`
      );
    });

    this.reminderWorker.on('completed', (job: Job) => {
      logger.info(`[ReminderScheduler] Job ${job.id} completed.`);
    });

    logger.info('[ReminderScheduler] BullMQ worker started on queue: ' + QUEUE_NAME);
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Core: scheduleReminders
  // ──────────────────────────────────────────────────────────────────────────

  /**
   * Schedules BullMQ delayed jobs for each deadline.
   * Deduplication: @@unique([emailId, deadline]) prevents duplicate reminder rows.
   * Past deadlines fire immediately with isOverdue=true.
   *
   * @returns Array of upserted Reminder records
   */
  public static async scheduleReminders(
    emailId: string,
    userId: string,
    deadlines: Date[]
  ): Promise<any[]> {
    const results: any[] = [];

    for (const deadline of deadlines) {
      if (isNaN(deadline.getTime())) {
        logger.warn(`[ReminderScheduler] Invalid deadline date skipped: ${deadline}`);
        continue;
      }

      try {
        // Upsert: if same emailId+deadline already exists, skip (no update = dedup)
        const existing = await prisma.reminder.findUnique({
          where: { emailId_deadline: { emailId, deadline } },
        });

        if (existing) {
          logger.info(
            `[ReminderScheduler] Reminder already exists for email ${emailId} deadline ${deadline.toISOString()} — skipping.`
          );
          results.push(existing);
          continue;
        }

        // Create reminder record first (status = PENDING, jobIds to be filled)
        const reminder = await prisma.reminder.create({
          data: {
            userId,
            emailId,
            deadline,
            offsets: DEFAULT_OFFSETS_MINUTES,
            status: 'PENDING',
            jobIds: [],
          },
        });

        const queue = this.getQueue();
        const jobIds: string[] = [];
        const now = Date.now();

        // Schedule one job per offset
        for (const offsetMinutes of DEFAULT_OFFSETS_MINUTES) {
          const triggerAt = deadline.getTime() - offsetMinutes * 60 * 1000;
          const delayMs = Math.max(0, triggerAt - now);
          const isOverdue = triggerAt <= now;

          const payload: ReminderFirePayload = {
            reminderId: reminder.id,
            emailId,
            userId,
            deadline: deadline.toISOString(),
            offsetMinutes,
            isOverdue,
          };

          if (queue) {
            const job = await queue.add('reminder.fire', payload, {
              delay: delayMs,
              jobId: `reminder-${reminder.id}-offset-${offsetMinutes}`,
            });
            jobIds.push(job.id || `reminder-${reminder.id}-offset-${offsetMinutes}`);
            logger.info(
              `[ReminderScheduler] Queued job for reminder ${reminder.id} offset=${offsetMinutes}m delay=${delayMs}ms isOverdue=${isOverdue}`
            );
          } else {
            // Fallback: schedule with setTimeout (non-persistent, dev mode)
            const capturedPayload = { ...payload };
            const capturedDelay = delayMs;
            setTimeout(() => {
              this.fireReminder(capturedPayload).catch((err) =>
                logger.error('[ReminderScheduler] In-memory fire failed:', err)
              );
            }, capturedDelay);
            logger.warn(
              `[ReminderScheduler] No Redis — using setTimeout for reminder ${reminder.id} (not persistent)`
            );
          }
        }

        // Persist job IDs to reminder for later cancellation
        const updatedReminder = await prisma.reminder.update({
          where: { id: reminder.id },
          data: { jobIds },
        });

        results.push(updatedReminder);
        logger.info(
          `[ReminderScheduler] Scheduled ${DEFAULT_OFFSETS_MINUTES.length} jobs for email ${emailId} deadline ${deadline.toISOString()}`
        );
      } catch (err: any) {
        // Handle unique constraint violation gracefully (race condition)
        if (err.code === 'P2002') {
          logger.info(
            `[ReminderScheduler] Duplicate reminder (race) for email ${emailId} deadline ${deadline.toISOString()} — skipped.`
          );
        } else {
          logger.error(
            `[ReminderScheduler] Failed to schedule reminder for email ${emailId}:`,
            err
          );
        }
      }
    }

    return results;
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Core: snoozeReminder
  // ──────────────────────────────────────────────────────────────────────────

  /**
   * Snoozes a reminder by durationMinutes.
   * Cancels existing pending jobs and schedules one new job after snooze period.
   */
  public static async snoozeReminder(
    reminderId: string,
    durationMinutes: number
  ): Promise<any> {
    const reminder = await prisma.reminder.findUnique({
      where: { id: reminderId },
      include: { email: { select: { subject: true } } },
    });

    if (!reminder) {
      throw new Error(`Reminder ${reminderId} not found.`);
    }
    if (reminder.status === 'CANCELLED') {
      throw new Error(`Cannot snooze a cancelled reminder.`);
    }

    const snoozeUntil = new Date(Date.now() + durationMinutes * 60 * 1000);

    // Remove currently pending BullMQ jobs
    await this.removeBullMQJobs(reminder.jobIds);

    // Schedule one snooze job
    const queue = this.getQueue();
    const payload: ReminderFirePayload = {
      reminderId: reminder.id,
      emailId: reminder.emailId,
      userId: reminder.userId,
      deadline: reminder.deadline.toISOString(),
      offsetMinutes: 0,
      isOverdue: false,
    };

    const newJobIds: string[] = [];
    if (queue) {
      const job = await queue.add('reminder.fire', payload, {
        delay: durationMinutes * 60 * 1000,
        jobId: `snooze-${reminder.id}-${Date.now()}`,
      });
      newJobIds.push(job.id || `snooze-${reminder.id}-${Date.now()}`);
    }

    const updated = await prisma.reminder.update({
      where: { id: reminderId },
      data: {
        status: 'SNOOZED',
        snoozeUntil,
        jobIds: newJobIds,
      },
    });

    logger.info(
      `[ReminderScheduler] Snoozed reminder ${reminderId} for ${durationMinutes} minutes until ${snoozeUntil.toISOString()}`
    );

    return updated;
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Core: cancelReminders
  // ──────────────────────────────────────────────────────────────────────────

  /**
   * Cancels all PENDING/SNOOZED reminders for a given email.
   * Removes their BullMQ jobs and marks them CANCELLED in DB.
   * Called when an ActionItem is marked done.
   */
  public static async cancelReminders(emailId: string): Promise<void> {
    const reminders = await prisma.reminder.findMany({
      where: {
        emailId,
        status: { in: ['PENDING', 'SNOOZED'] },
      },
    });

    if (reminders.length === 0) return;

    // Collect all job IDs across all reminders
    const allJobIds = reminders.flatMap((r) => r.jobIds);
    await this.removeBullMQJobs(allJobIds);

    // Bulk update to CANCELLED
    await prisma.reminder.updateMany({
      where: { emailId, status: { in: ['PENDING', 'SNOOZED'] } },
      data: { status: 'CANCELLED' },
    });

    logger.info(
      `[ReminderScheduler] Cancelled ${reminders.length} reminder(s) for email ${emailId}`
    );
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Core: fireReminder  (called by BullMQ worker)
  // ──────────────────────────────────────────────────────────────────────────

  /**
   * Processes a fired reminder job.
   * - Checks reminder is still active (not CANCELLED/SNOOZED since job was enqueued)
   * - Sends Telegram notification
   * - Logs a Notification record
   * - Updates reminder status if all offsets fired
   */
  public static async fireReminder(payload: ReminderFirePayload): Promise<void> {
    const { reminderId, userId, deadline, offsetMinutes, isOverdue } = payload;

    const reminder = await prisma.reminder.findUnique({
      where: { id: reminderId },
      include: {
        email: { select: { subject: true } },
      },
    });

    if (!reminder) {
      logger.warn(`[ReminderScheduler] fireReminder: reminder ${reminderId} not found — skipping.`);
      return;
    }

    if (reminder.status === 'CANCELLED') {
      logger.info(`[ReminderScheduler] Reminder ${reminderId} is CANCELLED — skipping fire.`);
      return;
    }

    // If SNOOZED and fire time is before snoozeUntil, skip (stale job)
    if (
      reminder.status === 'SNOOZED' &&
      reminder.snoozeUntil &&
      new Date() < reminder.snoozeUntil &&
      !isOverdue
    ) {
      logger.info(`[ReminderScheduler] Reminder ${reminderId} is SNOOZED — skipping stale fire.`);
      return;
    }

    // Fetch user Telegram settings
    const userSettings = await prisma.userSettings.findUnique({
      where: { userId },
    });

    const deadlineDate = new Date(deadline);
    const emailSubject = reminder.email?.subject || 'Email';

    // Determine label based on offset
    let offsetLabel = 'at deadline';
    if (offsetMinutes === 1440) offsetLabel = '24 hours before';
    else if (offsetMinutes === 60) offsetLabel = '1 hour before';

    const message = isOverdue
      ? `⚠️ OVERDUE: "${emailSubject}" — deadline was ${deadlineDate.toUTCString()}`
      : `🔔 Reminder (${offsetLabel}): "${emailSubject}" — deadline ${deadlineDate.toUTCString()}`;

    // Send via Telegram if configured
    let channel = 'system';
    if (userSettings?.telegramEnabled && userSettings?.telegramChatId) {
      try {
        await TelegramNotificationService.sendReminderAlert(
          userSettings.telegramChatId,
          {
            emailSubject,
            deadline: deadlineDate,
            offsetLabel,
            isOverdue,
          }
        );
        channel = 'telegram';
        logger.info(
          `[ReminderScheduler] Telegram reminder sent for reminder ${reminderId}`
        );
      } catch (teleErr: any) {
        logger.error(
          `[ReminderScheduler] Telegram send failed for reminder ${reminderId}:`,
          teleErr
        );
      }
    }

    // Create Notification record
    try {
      await prisma.notification.create({
        data: {
          userId,
          reminderId,
          channel,
          message,
          isRead: false,
        },
      });
    } catch (dbErr: any) {
      logger.error(`[ReminderScheduler] Failed to create Notification record:`, dbErr);
    }

    // Update reminder status: if this is the last offset (0 = at deadline), mark FIRED
    if (offsetMinutes === 0 || isOverdue) {
      await prisma.reminder.update({
        where: { id: reminderId },
        data: { status: 'FIRED' },
      });
      logger.info(`[ReminderScheduler] Reminder ${reminderId} marked FIRED.`);
    }
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Helpers
  // ──────────────────────────────────────────────────────────────────────────

  private static async removeBullMQJobs(jobIds: string[]): Promise<void> {
    const queue = this.getQueue();
    if (!queue || jobIds.length === 0) return;

    for (const jobId of jobIds) {
      try {
        const job = await queue.getJob(jobId);
        if (job) {
          await job.remove();
          logger.info(`[ReminderScheduler] Removed BullMQ job ${jobId}`);
        }
      } catch (err: any) {
        logger.warn(`[ReminderScheduler] Could not remove job ${jobId}: ${err.message}`);
      }
    }
  }

  /**
   * Graceful shutdown — closes queue and worker connections.
   */
  public static async shutdown(): Promise<void> {
    if (this.reminderWorker) {
      await this.reminderWorker.close();
      this.reminderWorker = null;
    }
    if (this.reminderQueue) {
      await this.reminderQueue.close();
      this.reminderQueue = null;
    }
    if (this.redisClient) {
      await this.redisClient.quit();
      this.redisClient = null;
    }
  }
}
