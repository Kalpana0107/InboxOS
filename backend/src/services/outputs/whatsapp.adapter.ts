import { PrismaClient } from '@prisma/client';
import { BaseOutputAdapter } from './base.adapter';
import { logger } from '../../utils/logger';
import { decrypt } from '../../utils/crypto';

const prisma = new PrismaClient();

export class WhatsAppAdapter implements BaseOutputAdapter {
  /**
   * Checks if DND is active for the user.
   */
  private checkDnd(settings: any): boolean {
    if (!settings.dndEnabled) return false;
    
    // Simplistic DND check assuming UTC for example
    if (settings.dndStart && settings.dndEnd) {
      const now = new Date();
      const currentHours = now.getUTCHours();
      const currentMinutes = now.getUTCMinutes();
      const currentTime = currentHours * 60 + currentMinutes;

      const [startH, startM] = settings.dndStart.split(':').map(Number);
      const [endH, endM] = settings.dndEnd.split(':').map(Number);
      
      const startTime = startH * 60 + startM;
      const endTime = endH * 60 + endM;

      if (startTime < endTime) {
        return currentTime >= startTime && currentTime <= endTime;
      } else {
        // Crosses midnight
        return currentTime >= startTime || currentTime <= endTime;
      }
    }
    return false;
  }

  /**
   * Fetches WhatsApp integration credentials for a user.
   */
  private async getCredentials(userId: string): Promise<{ accountSid: string, authToken: string, fromNumber: string, isMeta: boolean } | null> {
    const integration = await prisma.integration.findUnique({
      where: {
        userId_provider: {
          userId,
          provider: 'whatsapp'
        }
      }
    });

    if (!integration) return null;

    try {
      const decrypted = decrypt(integration.encryptedTokens);
      const creds = JSON.parse(decrypted);
      return creds;
    } catch (err) {
      logger.error(`[WhatsAppAdapter] Failed to parse credentials for user ${userId}`, err);
      return null;
    }
  }

  public async sendNotification(userId: string, emailSummary: any): Promise<boolean> {
    logger.info(`[WhatsAppAdapter] Attempting to send WhatsApp notification for user ${userId}`);
    
    const settings = await prisma.userSettings.findUnique({ where: { userId } });
    if (!settings) {
      logger.warn(`[WhatsAppAdapter] Settings not found for user ${userId}`);
      return false;
    }

    if (!settings.whatsappEnabled || !settings.whatsappNumber) {
      logger.info(`[WhatsAppAdapter] WhatsApp not enabled or number missing for user ${userId}`);
      return false;
    }

    if (this.checkDnd(settings)) {
      logger.info(`[WhatsAppAdapter] User ${userId} is currently in DND mode. Suppressing WhatsApp notification.`);
      return false;
    }

    const creds = await this.getCredentials(userId);
    if (!creds) {
      logger.warn(`[WhatsAppAdapter] Credentials not found for user ${userId}`);
      return false;
    }

    // Format Message
    const category = emailSummary.category || 'General';
    const sender = emailSummary.sender || 'Unknown Sender';
    const summary = emailSummary.summary || 'No summary provided.';
    const actionReq = emailSummary.actionRequired ? 'Yes' : 'No';

    let messageBody = `[${category}] from [${sender}]\n\n[${summary}]\n\nAction Required: [${actionReq}]\nReply STOP to pause.`;

    // Truncate to 1600 characters
    if (messageBody.length > 1600) {
      messageBody = messageBody.substring(0, 1597) + '...';
    }

    // Create a pending notification record
    const notification = await prisma.notification.create({
      data: {
        userId,
        channel: 'whatsapp',
        type: 'email_received',
        title: `WhatsApp Alert: ${category}`,
        message: messageBody,
        status: 'pending'
      }
    });

    try {
      let externalId = null;

      if (creds.isMeta) {
        // WhatsApp Business API (Meta)
        // Typically requires using Facebook Graph API
        logger.info(`[WhatsAppAdapter] Sending via Meta Business API`);
        // Implementation stub for Meta
        // ...
      } else {
        // Twilio (Primary)
        const to = `whatsapp:${settings.whatsappNumber}`;
        const from = `whatsapp:${creds.fromNumber}`;
        
        logger.info(`[WhatsAppAdapter] Sending via Twilio to ${to}`);
        
        const response = await fetch(
          `https://api.twilio.com/2010-04-01/Accounts/${creds.accountSid}/Messages.json`,
          {
            method: 'POST',
            headers: {
              Authorization: `Basic ${Buffer.from(`${creds.accountSid}:${creds.authToken}`).toString('base64')}`,
              'Content-Type': 'application/x-www-form-urlencoded',
            },
            body: new URLSearchParams({ From: from, To: to, Body: messageBody }),
          }
        );

        const data: any = await response.json();

        if (response.status === 429) {
          throw new Error('TWILIO_RATE_LIMIT');
        }

        if (!response.ok) {
          throw new Error(`Twilio error ${data.code}: ${data.message}`);
        }

        externalId = data.sid;
      }

      await prisma.notification.update({
        where: { id: notification.id },
        data: { status: 'sent', externalId, sentAt: new Date() }
      });

      return true;

    } catch (err: any) {
      logger.error(`[WhatsAppAdapter] Error sending message:`, err);
      
      await prisma.notification.update({
        where: { id: notification.id },
        data: { status: 'failed', metadata: { error: err.message } }
      });

      if (err.message === 'TWILIO_RATE_LIMIT' || err.message.includes('rate')) {
         // Let BullMQ retry this via exponential backoff (handled in worker)
         throw err; 
      }

      // If it's another error, we might not want to retry, but let's throw anyway to let the queue decide
      throw err;
    }
  }
}
