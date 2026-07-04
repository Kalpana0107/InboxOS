import * as dotenv from 'dotenv';
import * as path from 'path';

// Load environment variables
dotenv.config({ path: path.resolve(__dirname, '../.env') });

import express, { Request, Response, NextFunction } from 'express';
import helmet from 'helmet';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import { PrismaClient } from '@prisma/client';
import { z } from 'zod';
import { AuthService } from './services/auth.service';
import {
  requireAuth,
  AuthenticatedRequest,
} from './middleware/auth.middleware';
import {
  rateLimiter,
  globalIpRateLimiter,
} from './middleware/rate-limiter.middleware';
import client from './utils/metrics';
import { logger } from './utils/logger';
import { EventBus } from './services/event-bus.service';
import { RedisService } from './services/redis.service';
import { google } from 'googleapis';
import crypto from 'crypto';
import { EmailSenderService } from './services/email-sender.service';
import { encrypt } from './utils/crypto';
import { registerWorkerHandlers } from './worker';
import { Server as SocketIoServer } from 'socket.io';
import { WebSocketService } from './services/websocket.service';
import { TelegramBotService } from './services/telegram-bot.service';
import { TelegramNotificationService } from './services/telegram-notification.service';
import { initializeApp, cert } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { schemas, sanitizeHtml, sanitizeString } from './utils/validation';

const app = express();

// Initialize Firebase Admin SDK if credentials are provided
let firebaseAdminApp: any = null;
if (process.env.FIREBASE_PROJECT_ID && process.env.FIREBASE_CLIENT_EMAIL && process.env.FIREBASE_PRIVATE_KEY) {
  try {
    firebaseAdminApp = initializeApp({
      credential: cert({
        projectId: process.env.FIREBASE_PROJECT_ID,
        clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
        privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n'),
      }),
    });
    logger.info('Firebase Admin SDK initialized successfully');
  } catch (err) {
    logger.error('Failed to initialize Firebase Admin SDK:', err);
  }
} else {
  logger.warn('Firebase Admin credentials not fully configured in environment variables.');
}

const prisma = new PrismaClient();
const PORT = process.env.PORT || 8000;

// Trust the first reverse proxy in production so req.ip cannot be spoofed with
// an arbitrary X-Forwarded-For value.
app.set('trust proxy', process.env.NODE_ENV === 'production' ? 1 : false);

// Configure Helmet middleware for HTTP security headers
app.use(
  helmet({
    hsts: {
      maxAge: 31536000, // 1 year in seconds
      includeSubDomains: true,
      preload: true,
    },
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'"],
        imgSrc: ["'self'", 'data:', 'https:'],
        connectSrc: ["'self'", 'https://accounts.google.com'],
        fontSrc: ["'self'"],
        objectSrc: ["'none'"],
        mediaSrc: ["'self'"],
        frameSrc: ["'none'"],
      },
    },
    xFrameOptions: { action: 'deny' },
    xContentTypeOptions: true,
    referrerPolicy: { policy: 'no-referrer' },
    hidePoweredBy: true,
  })
);

// Configure CORS middleware with environment-specific allowed origins
const allowedOrigins =
  process.env.NODE_ENV === 'production'
    ? process.env.ALLOWED_ORIGINS?.split(',')
        .map((origin) => origin.trim())
        .filter(Boolean) || []
    : [
        'http://localhost:5173',
        'http://localhost:3000',
        'http://127.0.0.1:5173',
        'http://127.0.0.1:3000',
      ];

type CorsError = Error & { code: 'CORS_NOT_ALLOWED' };

const corsOrigin = (
  origin: string | undefined,
  callback: (error: Error | null, allowed?: boolean) => void
) => {
  // Requests without an Origin header include server-to-server and CLI clients.
  if (!origin || allowedOrigins.includes(origin)) {
    callback(null, true);
    return;
  }

  logger.warn('CORS origin rejected', {
    ip: 'unknown',
    path: 'cors',
    method: 'OPTIONS',
    origin,
  });
  const error = new Error('Not allowed by CORS') as CorsError;
  error.code = 'CORS_NOT_ALLOWED';
  callback(error);
};

app.use(
  cors({
    origin: corsOrigin,
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With'],
  })
);

app.get('/metrics', async (req: Request, res: Response) => {
  const ip = req.ip || req.socket.remoteAddress || '';
  const cleanIp = ip.startsWith('::ffff:') ? ip.substring(7) : ip;
  const isLocalhost =
    cleanIp === '127.0.0.1' || cleanIp === '::1' || cleanIp === 'localhost';

  let isPrivate = false;
  const ipParts = cleanIp.split('.');
  if (ipParts.length === 4) {
    const first = parseInt(ipParts[0], 10);
    const second = parseInt(ipParts[1], 10);
    if (first === 10) isPrivate = true;
    if (first === 172 && second >= 16 && second <= 31) isPrivate = true;
    if (first === 192 && second === 168) isPrivate = true;
  }

  const metricsToken = process.env.METRICS_TOKEN;
  const tokenHeader = req.headers['x-metrics-token'];
  const hasValidToken = metricsToken && tokenHeader === metricsToken;

  if (!isLocalhost && !isPrivate && !hasValidToken) {
    logger.warn('Forbidden access attempt to /metrics', { ip: cleanIp });
    return res.status(403).json({ error: 'Forbidden' });
  }

  try {
    res.set('Content-Type', client.register.contentType);
    res.end(await client.register.metrics());
  } catch (err: any) {
    logger.error('Failed to generate Prometheus metrics', {
      error: err.message,
    });
    res.status(500).end(err);
  }
});

// Configure body parser size limits (10MB)
const MAX_REQUEST_SIZE = '10mb';
app.use(express.json({ limit: MAX_REQUEST_SIZE }));
app.use(express.urlencoded({ extended: true, limit: MAX_REQUEST_SIZE }));
app.use(cookieParser());

// Apply global IP-based rate limiting to all /api routes except health check
app.use('/api', (req, res, next) => {
  if (req.path === '/health') {
    return next();
  }
  return globalIpRateLimiter(req, res, next);
});

// Apply auth-based rate limiting to all /api routes
app.use('/api', rateLimiter);

/**
 * GET /api/health
 * Lightweight API health check endpoint.
 */
app.get('/api/health', async (req: Request, res: Response) => {
  const telegramHealth = await TelegramBotService.checkHealth();
  res.status(200).json({
    status: 'ok',
    timestamp: new Date(),
    telegram: {
      status: telegramHealth.connected ? '✅ Connected' : '❌ Disconnected',
      webhook: telegramHealth.webhookActive
        ? '✅ Active'
        : '❌ Inactive / Polling',
      botApi: telegramHealth.reachable ? '✅ Reachable' : '❌ Unreachable',
    },
  });
});

/**
 * POST /api/auth/register
 * Creates a new user in the database.
 */
const registerSchema = z.object({
  email: schemas.email,
  password: z
    .string()
    .min(8, 'Password must be at least 8 characters')
    .max(100),
});

app.post('/api/auth/register', async (req: Request, res: Response) => {
  try {
    // Validate request body
    const validation = registerSchema.safeParse(req.body);
    if (!validation.success) {
      return res.status(400).json({
        error: 'Invalid payload schema',
        details: validation.error.flatten(),
      });
    }

    const { email, password } = validation.data;

    // Check if email already exists
    const existingUser = await prisma.user.findUnique({
      where: { email },
    });

    if (existingUser) {
      return res
        .status(400)
        .json({ error: 'User with this email already exists' });
    }

    // Hash the password with 10 salt rounds
    const passwordHash = await AuthService.hashPassword(password);

    // Create user
    const newUser = await prisma.user.create({
      data: {
        email,
        passwordHash,
      },
    });

    // Generate JWT token for auto-login
    const token = AuthService.generateToken(newUser.id, newUser.email);

    // Set cookie
    res.cookie('token', token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: 24 * 60 * 60 * 1000, // 24 hours
    });

    return res.status(201).json({
      message: 'User registered successfully',
      user: {
        id: newUser.id,
        email: newUser.email,
        createdAt: newUser.createdAt,
      },
    });
  } catch (error) {
    console.error('Registration error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * POST /api/auth/login
 * Validates credentials and sets an HTTP-only JWT cookie.
 */
const loginSchema = z.object({
  email: schemas.email,
  password: z.string().min(1, 'Password is required'),
});

app.post('/api/auth/login', async (req: Request, res: Response) => {
  try {
    // Validate request body
    const validation = loginSchema.safeParse(req.body);
    if (!validation.success) {
      return res.status(400).json({
        error: 'Invalid payload schema',
        details: validation.error.flatten(),
      });
    }

    const { email, password } = validation.data;

    // Fetch user
    const user = await prisma.user.findUnique({
      where: { email },
    });

    if (!user) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    // Verify password
    const isPasswordValid = await AuthService.comparePassword(
      password,
      user.passwordHash
    );
    if (!isPasswordValid) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    // Generate JWT token
    const token = AuthService.generateToken(user.id, user.email);

    // Set cookie
    res.cookie('token', token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: 24 * 60 * 60 * 1000, // 24 hours
    });

    // Dispatch Telegram security notification alert if enabled
    try {
      const userSettings = await prisma.userSettings.findFirst({
        where: { userId: user.id, telegramEnabled: true },
      });
      if (userSettings && userSettings.telegramChatId) {
        await TelegramNotificationService.sendAuthAlert(
          userSettings.telegramChatId,
          `New login detected on your InboxOS account (${user.email}) at ${new Date().toISOString()}`
        );
      }
    } catch (teleErr) {
      logger.error('Failed to send Telegram auth alert:', teleErr);
    }

    return res.status(200).json({
      message: 'Logged in successfully',
      user: {
        id: user.id,
        email: user.email,
      },
    });
  } catch (error) {
    console.error('Login error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * POST /api/auth/firebase
 * Accepts Firebase ID token, verifies it, finds/creates a user, and returns standard JWT cookie.
 */
app.post('/api/auth/firebase', async (req: Request, res: Response) => {
  try {
    const { idToken } = req.body;
    if (!idToken) {
      return res.status(400).json({ error: 'Firebase idToken is required' });
    }

    if (!firebaseAdminApp) {
      return res.status(500).json({ error: 'Firebase Admin is not configured on this server.' });
    }

    // Verify token
    const decodedToken = await getAuth().verifyIdToken(idToken);
    const email = decodedToken.email;
    if (!email) {
      return res.status(400).json({ error: 'Email not present in Firebase token' });
    }

    // Check if user exists
    let user = await prisma.user.findUnique({
      where: { email },
    });

    if (!user) {
      // Create user with a dummy password hash (since they authenticate with Google/Firebase)
      const dummyPassword = crypto.randomBytes(32).toString('hex');
      const passwordHash = await AuthService.hashPassword(dummyPassword);

      user = await prisma.user.create({
        data: {
          email,
          passwordHash,
        },
      });
    }

    // Generate internal JWT token
    const token = AuthService.generateToken(user.id, user.email);

    // Set cookie
    res.cookie('token', token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: 24 * 60 * 60 * 1000, // 24 hours
    });

    // Telegram security alert
    try {
      const userSettings = await prisma.userSettings.findFirst({
        where: { userId: user.id, telegramEnabled: true },
      });
      if (userSettings && userSettings.telegramChatId) {
        await TelegramNotificationService.sendAuthAlert(
          userSettings.telegramChatId,
          `New Google login via Firebase detected on your InboxOS account (${user.email}) at ${new Date().toISOString()}`
        );
      }
    } catch (teleErr) {
      logger.error('Failed to send Telegram auth alert:', teleErr);
    }

    return res.status(200).json({
      message: 'Logged in successfully',
      user: {
        id: user.id,
        email: user.email,
      },
    });
  } catch (error: any) {
    console.error('Firebase Auth error:', error);
    return res.status(401).json({ error: 'Invalid Firebase ID token' });
  }
});

/**
 * POST /api/auth/logout
 * Clears the HTTP-only auth cookie.
 */
app.post('/api/auth/logout', (_req: Request, res: Response) => {
  res.clearCookie('token');
  return res.status(200).json({ message: 'Logged out successfully' });
});

/**
 * GET /api/auth/me
 * Protected endpoint to fetch current authenticated user profile.
 */
app.get(
  '/api/auth/me',
  requireAuth,
  (req: AuthenticatedRequest, res: Response) => {
    return res.status(200).json({
      user: req.user,
    });
  }
);

/**
 * GET /api/users/profile
 * Protected endpoint to fetch current authenticated user profile.
 */
app.get(
  '/api/users/profile',
  requireAuth,
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      const userId = req.user?.userId;
      if (!userId) {
        return res.status(401).json({ error: 'Unauthorized' });
      }

      const cacheKey = `user:profile:${userId}`;

      // Try fetching from Redis cache first
      const cachedProfile = await RedisService.get(cacheKey);
      if (cachedProfile) {
        try {
          const parsedProfile = JSON.parse(cachedProfile);
          return res.status(200).json(parsedProfile);
        } catch (parseError) {
          console.warn('Failed to parse cached user profile JSON:', parseError);
        }
      }

      // Fetch from Prisma if not cached
      const user = await prisma.user.findUnique({
        where: { id: userId },
        select: {
          id: true,
          email: true,
          createdAt: true,
          settings: {
            select: {
              theme: true,
              signature: true,
              autoReply: true,
            },
          },
        },
      });

      if (!user) {
        return res.status(404).json({ error: 'User not found' });
      }

      // Store in cache for 300 seconds
      await RedisService.setex(cacheKey, 300, JSON.stringify(user));

      return res.status(200).json(user);
    } catch (error) {
      console.error('Fetch profile error:', error);
      return res.status(500).json({ error: 'Internal server error' });
    }
  }
);

/**
 * POST /api/webhooks/incoming
 * Webhook endpoint that ingests incoming emails, checks for thread association,
 * validates body structures via Zod, and creates records in PostgreSQL.
 */
const incomingEmailSchema = z.object({
  sender: schemas.email,
  recipient: schemas.email,
  subject: schemas.subject,
  body: schemas.body.transform(sanitizeHtml),
  messageId: schemas.messageId,
  inReplyTo: z.string().optional(),
});

app.post('/api/webhooks/incoming', async (req: Request, res: Response) => {
  try {
    // 1. Strict payload validation with Zod
    const validation = incomingEmailSchema.safeParse(req.body);
    if (!validation.success) {
      return res.status(400).json({
        error: 'Invalid payload schema',
        details: validation.error.flatten(),
      });
    }

    const { sender, recipient, subject, body, messageId, inReplyTo } =
      validation.data;

    // 2. Fetch or dynamically create the recipient User
    let user = await prisma.user.findUnique({
      where: { email: recipient },
    });

    if (!user) {
      user = await prisma.user.create({
        data: {
          email: recipient,
          passwordHash: await AuthService.hashPassword(
            'webhook-generated-password-hash'
          ),
        },
      });
    }

    // 3. Check for thread association via In-Reply-To header / messageId
    let threadId: string | null = null;
    if (inReplyTo) {
      const previousEmail = await prisma.email.findUnique({
        where: { messageId: inReplyTo },
      });
      if (previousEmail) {
        threadId = previousEmail.threadId;
      }
    }

    // If no existing thread is found, spin up a new Thread
    if (!threadId) {
      const newThread = await prisma.thread.create({
        data: {
          summary: `Thread for: ${subject}`,
        },
      });
      threadId = newThread.id;
    }

    // 4. Create the Email record
    const emailRecord = await prisma.email.create({
      data: {
        messageId,
        inReplyTo: inReplyTo || null,
        sender,
        recipient,
        subject,
        body,
        status: 'UNREAD',
        userId: user.id,
        threadId,
      },
    });

    // 5. Publish event to decouple AI processing
    await EventBus.publish('email.received', { emailId: emailRecord.id });

    // 6. Return 201 Created immediately
    return res.status(201).json({
      message: 'Email ingested successfully',
      email: {
        id: emailRecord.id,
        messageId: emailRecord.messageId,
        subject: emailRecord.subject,
        threadId: emailRecord.threadId,
        createdAt: emailRecord.createdAt,
      },
    });
  } catch (error) {
    console.error('Incoming webhook error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * POST /api/telegram/webhook
 * Receives update callbacks from Telegram Bot API.
 * Validates header secret parameter if configured.
 */
app.post('/api/telegram/webhook', async (req: Request, res: Response) => {
  const secretToken = req.headers['x-telegram-bot-api-secret-token'];
  const configuredSecret = process.env.TELEGRAM_WEBHOOK_SECRET || '';

  if (configuredSecret && secretToken !== configuredSecret) {
    logger.warn(
      '[TelegramBot] Rejected unauthorized webhook request (invalid x-telegram-bot-api-secret-token)'
    );
    return res.status(403).json({ error: 'Unauthorized' });
  }

  try {
    const update = z
      .object({ update_id: z.number().int().nonnegative() })
      .passthrough()
      .safeParse(req.body);
    if (!update.success) {
      return res.status(400).json({ error: 'Invalid Telegram update' });
    }

    // Process update asynchronously to respond immediately to Telegram
    TelegramBotService.handleUpdate(update.data).catch((e) => {
      logger.error('[TelegramBot] Async handleUpdate error:', e);
    });
    return res.status(200).json({ ok: true });
  } catch (err: any) {
    logger.error('[TelegramBot] Webhook exception error:', err);
    return res.status(500).json({ error: 'Internal Server Error' });
  }
});

/**
 * GET /api/users/me/settings
 * Fetches user-specific preferences. If not initialized, returns system defaults.
 */
app.get(
  '/api/users/me/settings',
  requireAuth,
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      const userId = req.user?.userId;
      if (!userId) {
        return res.status(401).json({ error: 'Unauthorized' });
      }

      const settings = await prisma.userSettings.findUnique({
        where: { userId },
      });

      if (!settings) {
        return res.status(200).json({
          theme: 'dark',
          signature: null,
          autoReply: false,
        });
      }

      return res.status(200).json({
        theme: settings.theme,
        signature: settings.signature,
        autoReply: settings.autoReply,
      });
    } catch (error) {
      console.error('Fetch settings error:', error);
      return res.status(500).json({ error: 'Internal server error' });
    }
  }
);

/**
 * PUT /api/users/me/settings
 * Updates (or initializes) user-specific preferences, validating parameters via Zod.
 */
const updateSettingsSchema = z.object({
  theme: z.string().min(1).max(50).transform(sanitizeString).optional(),
  signature: z.string().max(5000).transform(sanitizeHtml).nullable().optional(),
  autoReply: z.boolean().optional(),
});

app.put(
  '/api/users/me/settings',
  requireAuth,
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      const userId = req.user?.userId;
      if (!userId) {
        return res.status(401).json({ error: 'Unauthorized' });
      }

      const validation = updateSettingsSchema.safeParse(req.body);
      if (!validation.success) {
        return res.status(400).json({
          error: 'Invalid payload schema',
          details: validation.error.flatten(),
        });
      }

      const { theme, signature, autoReply } = validation.data;

      const updatedSettings = await prisma.userSettings.upsert({
        where: { userId },
        update: {
          ...(theme !== undefined && { theme }),
          ...(signature !== undefined && { signature }),
          ...(autoReply !== undefined && { autoReply }),
        },
        create: {
          userId,
          theme: theme ?? 'dark',
          signature: signature ?? null,
          autoReply: autoReply ?? false,
        },
      });

      return res.status(200).json({
        message: 'Settings updated successfully',
        settings: {
          theme: updatedSettings.theme,
          signature: updatedSettings.signature,
          autoReply: updatedSettings.autoReply,
        },
      });
    } catch (error) {
      console.error('Update settings error:', error);
      return res.status(500).json({ error: 'Internal server error' });
    }
  }
);

// OAuth2 & Encryption config
const oauth2Client = new google.auth.OAuth2(
  process.env.GMAIL_CLIENT_ID,
  process.env.GMAIL_CLIENT_SECRET,
  process.env.GMAIL_REDIRECT_URI ||
    'http://localhost:8000/api/integrations/gmail/callback'
);

/**
 * GET /api/integrations/gmail/auth
 * Generates the Google OAuth URL.
 */
app.get(
  '/api/integrations/gmail/auth',
  requireAuth,
  (req: AuthenticatedRequest, res: Response) => {
    const url = oauth2Client.generateAuthUrl({
      access_type: 'offline',
      scope: ['https://mail.google.com/'],
      prompt: 'consent',
      state: req.user?.userId,
    });
    return res.json({ url });
  }
);

/**
 * GET /api/integrations/gmail/callback
 * Exchanges the auth code for tokens and saves them to Prisma securely.
 */
app.get(
  '/api/integrations/gmail/callback',
  async (req: Request, res: Response) => {
    const code = req.query.code as string;
    const userId = req.query.state as string;

    // Validate required parameters
    if (!code || !userId) {
      return res
        .status(400)
        .json({ error: 'Missing code or state parameters' });
    }

    // Sanitize inputs to prevent injection
    const sanitizedCode = sanitizeString(code);
    const sanitizedUserId = sanitizeString(userId);

    if (sanitizedCode.length === 0 || sanitizedUserId.length === 0) {
      return res
        .status(400)
        .json({ error: 'Invalid code or state parameters' });
    }

    try {
      const { tokens } = await oauth2Client.getToken(sanitizedCode);
      oauth2Client.setCredentials(tokens);

      const gmail = google.gmail({ version: 'v1', auth: oauth2Client });
      const profile = await gmail.users.getProfile({ userId: 'me' });
      const emailAddress = profile.data.emailAddress;

      if (!emailAddress) {
        return res
          .status(400)
          .json({ error: 'Could not fetch email address from Google' });
      }

      // Validate email address format
      const emailValidation = schemas.email.safeParse(emailAddress);
      if (!emailValidation.success) {
        return res
          .status(400)
          .json({ error: 'Invalid email address from Google' });
      }

      // ── Google Sign-In flow ───────────────────────────────────────────────────
      // If state is 'google-signin', auto-create or find the user by Gmail address
      // then set a JWT cookie and redirect to the dashboard.
      if (sanitizedUserId === 'google-signin') {
        let user = await prisma.user.findUnique({
          where: { email: emailValidation.data },
        });
        if (!user) {
          user = await prisma.user.create({
            data: {
              email: emailValidation.data,
              passwordHash: crypto.randomBytes(32).toString('hex'), // unusable password — Google is the auth
            },
          });
        }

        const jwtToken = AuthService.generateToken(user.id, user.email);
        res.cookie('token', jwtToken, {
          httpOnly: true,
          secure: process.env.NODE_ENV === 'production',
          sameSite: 'lax',
          maxAge: 24 * 60 * 60 * 1000,
        });

        // Also connect their Gmail account
        const encryptedTokens = encrypt(JSON.stringify(tokens));
        await prisma.emailAccount.upsert({
          where: {
            userId_provider_emailAddress: {
              userId: user.id,
              provider: 'gmail',
              emailAddress: emailValidation.data,
            },
          },
          update: {
            encryptedTokens,
            syncState: 'connected',
            lastSyncAt: new Date(),
          },
          create: {
            userId: user.id,
            provider: 'gmail',
            emailAddress: emailValidation.data,
            encryptedTokens,
            syncState: 'connected',
          },
        });

        return res.redirect('http://localhost:5173/');
      }

      // ── Connect Gmail to existing account flow ────────────────────────────────
      // Validate userId is a valid UUID
      const userIdValidation = schemas.uuid.safeParse(sanitizedUserId);
      if (!userIdValidation.success) {
        return res.status(400).json({ error: 'Invalid user ID format' });
      }

      const encryptedTokens = encrypt(JSON.stringify(tokens));

      // Save to Database
      await prisma.emailAccount.upsert({
        where: {
          userId_provider_emailAddress: {
            userId: userIdValidation.data,
            provider: 'gmail',
            emailAddress: emailValidation.data,
          },
        },
        update: {
          encryptedTokens,
          syncState: 'connected',
          lastSyncAt: new Date(),
        },
        create: {
          userId: userIdValidation.data,
          provider: 'gmail',
          emailAddress: emailValidation.data,
          encryptedTokens,
          syncState: 'connected',
        },
      });

      return res.status(200).json({
        message: 'Gmail connected successfully',
        emailAddress: emailValidation.data,
      });
    } catch (error) {
      console.error('OAuth callback error:', error);
      return res.status(500).json({ error: 'OAuth integration failed' });
    }
  }
);

/**
 * POST /api/emails/send
 * Sends an outbound email via SMTP
 */
const sendEmailSchema = z.object({
  to: schemas.email,
  subject: schemas.subject,
  text: schemas.body.pipe(z.string().min(1)),
  html: schemas.body.transform(sanitizeHtml).optional(),
  inReplyTo: z.string().optional(),
});

app.post(
  '/api/emails/send',
  requireAuth,
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      const userId = req.user?.userId;
      if (!userId) return res.status(401).json({ error: 'Unauthorized' });

      // Validate request body
      const validation = sendEmailSchema.safeParse(req.body);
      if (!validation.success) {
        return res.status(400).json({
          error: 'Invalid payload schema',
          details: validation.error.flatten(),
        });
      }

      const { to, subject, text, html, inReplyTo } = validation.data;

      const result = await EmailSenderService.send(userId, {
        to,
        subject,
        text,
        html,
        inReplyTo,
      });
      return res.status(200).json({
        message: 'Email sent successfully',
        messageId: result.messageId,
      });
    } catch (error: any) {
      console.error('Send email error:', error.message);
      return res.status(500).json({ error: 'Failed to send email' });
    }
  }
);

/**
 * Webhook Config Routes
 */

/**
 * Webhook configuration schema with URL validation
 */
const webhookConfigSchema = z.object({
  targetUrl: schemas.url,
  events: z.array(z.string()).min(1),
});

const webhookUpdateSchema = z
  .object({
    targetUrl: schemas.url.optional(),
    events: z.array(z.string()).min(1).optional(),
  })
  .refine((data) => data.targetUrl !== undefined || data.events !== undefined, {
    message: 'At least one field (targetUrl or events) must be provided',
  });

app.post(
  '/api/webhooks/config',
  requireAuth,
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      const userId = req.user?.userId;
      if (!userId) return res.status(401).json({ error: 'Unauthorized' });

      // Validate request body
      const validation = webhookConfigSchema.safeParse(req.body);
      if (!validation.success) {
        return res.status(400).json({
          error: 'Invalid payload schema',
          details: validation.error.flatten(),
        });
      }

      const { targetUrl, events } = validation.data;

      const secret = crypto.randomBytes(32).toString('hex');
      const hook = await prisma.webhookEndpoint.create({
        data: { targetUrl, events: JSON.stringify(events), secret, userId },
      });

      return res.json({
        id: hook.id,
        targetUrl: hook.targetUrl,
        events: JSON.parse(hook.events),
        secret: hook.secret,
      });
    } catch (err) {
      return res.status(500).json({ error: 'Failed to create webhook' });
    }
  }
);

app.get(
  '/api/webhooks/config',
  requireAuth,
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      const userId = req.user?.userId;
      if (!userId) return res.status(401).json({ error: 'Unauthorized' });

      const hooks = await prisma.webhookEndpoint.findMany({
        where: { userId },
      });
      const formatted = hooks.map((h) => ({
        id: h.id,
        targetUrl: h.targetUrl,
        events: JSON.parse(h.events),
      }));
      return res.json(formatted);
    } catch (err) {
      return res.status(500).json({ error: 'Failed to fetch webhooks' });
    }
  }
);

app.patch(
  '/api/webhooks/config/:id',
  requireAuth,
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      const userId = req.user?.userId;
      if (!userId) return res.status(401).json({ error: 'Unauthorized' });

      const id = req.params.id as string;

      // Validate UUID format
      const idValidation = schemas.uuid.safeParse(id);
      if (!idValidation.success) {
        return res.status(400).json({
          error: 'Invalid webhook ID format',
          details: idValidation.error.flatten(),
        });
      }

      // Validate request body
      const validation = webhookUpdateSchema.safeParse(req.body);
      if (!validation.success) {
        return res.status(400).json({
          error: 'Invalid payload schema',
          details: validation.error.flatten(),
        });
      }

      const { targetUrl, events } = validation.data;

      const hook = await prisma.webhookEndpoint.findUnique({
        where: { id: idValidation.data },
      });
      if (!hook || hook.userId !== userId)
        return res.status(404).json({ error: 'Not found' });

      await prisma.webhookEndpoint.update({
        where: { id: idValidation.data },
        data: {
          ...(targetUrl && { targetUrl }),
          ...(events && { events: JSON.stringify(events) }),
        },
      });
      return res.json({ message: 'Webhook updated' });
    } catch (err) {
      return res.status(500).json({ error: 'Failed to update webhook' });
    }
  }
);

app.delete(
  '/api/webhooks/config/:id',
  requireAuth,
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      const userId = req.user?.userId;
      if (!userId) return res.status(401).json({ error: 'Unauthorized' });

      const id = req.params.id as string;

      // Validate UUID format
      const validation = schemas.uuid.safeParse(id);
      if (!validation.success) {
        return res.status(400).json({
          error: 'Invalid webhook ID format',
          details: validation.error.flatten(),
        });
      }

      const hook = await prisma.webhookEndpoint.findUnique({
        where: { id: validation.data },
      });
      if (!hook || hook.userId !== userId)
        return res.status(404).json({ error: 'Not found' });

      await prisma.webhookEndpoint.delete({ where: { id: validation.data } });
      return res.json({ message: 'Webhook deleted' });
    } catch (err) {
      return res.status(500).json({ error: 'Failed to delete webhook' });
    }
  }
);

/**
 * GET /api/dashboard/stats
 * Returns live dashboard metrics/statistics for the authenticated user.
 */
app.get(
  '/api/dashboard/stats',
  requireAuth,
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      const userId = req.user?.userId;
      if (!userId) return res.status(401).json({ error: 'Unauthorized' });

      const now = new Date();
      const last24h = new Date(now.getTime() - 24 * 60 * 60 * 1000);
      const prev24h = new Date(now.getTime() - 48 * 60 * 60 * 1000);

      // 1. Total Ingested
      const totalIngested = await prisma.email.count({
        where: { userId },
      });
      const last24hIngested = await prisma.email.count({
        where: { userId, createdAt: { gte: last24h } },
      });
      const prev24hIngested = await prisma.email.count({
        where: { userId, createdAt: { gte: prev24h, lt: last24h } },
      });
      let ingestedChange = 0;
      if (prev24hIngested > 0) {
        ingestedChange = Math.round(((last24hIngested - prev24hIngested) / prev24hIngested) * 100);
      } else if (last24hIngested > 0) {
        ingestedChange = 100;
      }

      // 2. Urgent / Pending Actions
      const pendingActions = await prisma.actionItem.count({
        where: {
          isCompleted: false,
          email: { userId },
        },
      });
      const last24hPending = await prisma.actionItem.count({
        where: {
          isCompleted: false,
          email: { userId },
          createdAt: { gte: last24h },
        },
      });
      const prev24hPending = await prisma.actionItem.count({
        where: {
          isCompleted: false,
          email: { userId },
          createdAt: { gte: prev24h, lt: last24h },
        },
      });
      let pendingChange = 0;
      if (prev24hPending > 0) {
        pendingChange = Math.round(((last24hPending - prev24hPending) / prev24hPending) * 100);
      } else if (last24hPending > 0) {
        pendingChange = 100;
      }

      // 3. Resolved Rate
      const totalTasks = await prisma.actionItem.count({
        where: { email: { userId } },
      });
      const completedTasks = await prisma.actionItem.count({
        where: { isCompleted: true, email: { userId } },
      });
      const resolutionRate = totalTasks > 0 ? Math.round((completedTasks / totalTasks) * 100) : 0;

      // Previous 24h resolution rate to calculate trend
      const prevTotalTasks = await prisma.actionItem.count({
        where: { email: { userId }, createdAt: { lt: last24h } },
      });
      const prevCompletedTasks = await prisma.actionItem.count({
        where: { isCompleted: true, email: { userId }, createdAt: { lt: last24h } },
      });
      const prevResolutionRate = prevTotalTasks > 0 ? Math.round((prevCompletedTasks / prevTotalTasks) * 100) : 0;

      let resolutionChange = 0;
      if (prevResolutionRate > 0) {
        resolutionChange = Math.round(((resolutionRate - prevResolutionRate) / prevResolutionRate) * 100);
      } else if (resolutionRate > 0) {
        resolutionChange = 100;
      }

      return res.status(200).json({
        totalIngested: {
          value: totalIngested,
          change: `${ingestedChange >= 0 ? '+' : ''}${ingestedChange}%`,
          isPositive: ingestedChange >= 0,
        },
        pendingActions: {
          value: pendingActions,
          change: `${pendingChange >= 0 ? '+' : ''}${pendingChange}%`,
          isPositive: pendingChange <= 0, // decrease in pending items is positive
        },
        resolutionRate: {
          value: `${resolutionRate}%`,
          change: `${resolutionChange >= 0 ? '+' : ''}${resolutionChange}%`,
          isPositive: resolutionChange >= 0,
        },
      });
    } catch (error) {
      console.error('Failed to calculate dashboard stats:', error);
      return res.status(500).json({ error: 'Internal server error' });
    }
  }
);

/**
 * GET /api/emails
 * Returns paginated email list for the logged-in user.
 * Called by frontend EmailList.tsx
 */
app.get(
  '/api/emails',
  requireAuth,
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      const userId = req.user?.userId;
      if (!userId) return res.status(401).json({ error: 'Unauthorized' });

      // Validate and sanitize query parameters
      const limitQuery = parseInt(req.query.limit as string, 10);
      const offsetQuery = parseInt(req.query.offset as string, 10);
      const category = req.query.category as string | undefined;
      let validatedCategory: string | undefined;

      // Apply safe defaults and limits
      const limit =
        isNaN(limitQuery) || limitQuery <= 0 ? 10 : Math.min(limitQuery, 100);
      const offset = isNaN(offsetQuery) || offsetQuery < 0 ? 0 : offsetQuery;

      // Validate category if provided
      if (category && category !== 'all') {
        validatedCategory = sanitizeString(category);
        if (validatedCategory.length === 0) {
          return res.status(400).json({
            error: 'Invalid category parameter',
          });
        }
      }

      const where: any = { userId };
      if (validatedCategory) where.category = validatedCategory;

      const [emails, total] = await Promise.all([
        prisma.email.findMany({
          where,
          orderBy: { createdAt: 'desc' },
          take: limit,
          skip: offset,
          select: {
            id: true,
            messageId: true,
            sender: true,
            recipient: true,
            subject: true,
            body: true,
            status: true,
            category: true,
            createdAt: true,
            threadId: true,
          },
        }),
        prisma.email.count({ where }),
      ]);

      return res.json({ emails, total, limit, offset });
    } catch (err) {
      console.error('GET /api/emails error:', err);
      return res.status(500).json({ error: 'Failed to fetch emails' });
    }
  }
);

/**
 * GET /api/emails/search
 * Search user's emails by subject or body with pagination.
 */
app.get(
  '/api/emails/search',
  requireAuth,
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      const userId = req.user?.userId;
      if (!userId) {
        return res.status(401).json({ error: 'Unauthorized' });
      }

      const { q } = req.query;
      if (typeof q !== 'string' || !q.trim()) {
        return res.status(400).json({
          error: 'Query parameter "q" is required and cannot be empty',
        });
      }

      // Sanitize search query to prevent injection attacks
      const sanitizedQuery = sanitizeString(q);
      if (sanitizedQuery.length === 0) {
        return res.status(400).json({
          error: 'Query parameter contains invalid characters',
        });
      }

      // Parse pagination parameters
      const limitQuery = parseInt(req.query.limit as string, 10);
      const offsetQuery = parseInt(req.query.offset as string, 10);

      const limit =
        isNaN(limitQuery) || limitQuery <= 0 ? 20 : Math.min(limitQuery, 20);
      const offset = isNaN(offsetQuery) || offsetQuery < 0 ? 0 : offsetQuery;

      // Search query object with sanitized input
      const searchFilter = {
        userId,
        OR: [
          { subject: { contains: sanitizedQuery } },
          { body: { contains: sanitizedQuery } },
        ],
      };

      // Run both count and select queries concurrently
      const [total, emails] = await Promise.all([
        prisma.email.count({ where: searchFilter as any }),
        prisma.email.findMany({
          where: searchFilter as any,
          take: limit,
          skip: offset,
          orderBy: { createdAt: 'desc' },
        }),
      ]);

      return res.status(200).json({
        emails,
        pagination: {
          total,
          limit,
          offset,
        },
      });
    } catch (error) {
      console.error('Email search error:', error);
      return res.status(500).json({ error: 'Internal server error' });
    }
  }
);

/**
 * GET /api/emails/:id
 * Returns a single email with its thread list and action items.
 */
app.get(
  '/api/emails/:id',
  requireAuth,
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      const userId = req.user?.userId;
      if (!userId) return res.status(401).json({ error: 'Unauthorized' });

      const id = req.params.id as string;

      // Validate UUID format using Zod schema
      const validation = schemas.uuid.safeParse(id);
      if (!validation.success) {
        return res.status(400).json({
          error: 'Invalid email ID format',
          details: validation.error.flatten(),
        });
      }

      const email = await prisma.email.findUnique({
        where: { id: validation.data },
        include: {
          actionItems: true,
          thread: {
            include: {
              emails: {
                orderBy: {
                  createdAt: 'asc',
                },
              },
            },
          },
        },
      });

      if (!email || email.userId !== userId) {
        return res.status(404).json({ error: 'Email not found' });
      }

      return res.json(email);
    } catch (error) {
      console.error('GET /api/emails/:id error:', error);
      return res.status(500).json({ error: 'Failed to fetch email details' });
    }
  }
);

/**
 * Rules Engine Validation Schemas
 */
const ruleConditionSchema = z.object({
  field: z.enum([
    'from',
    'to',
    'subject',
    'body',
    'category',
    'priority',
    'hasAttachments',
    'senderDomain',
  ]),
  operator: z.enum([
    'equals',
    'contains',
    'startsWith',
    'endsWith',
    'regex',
    'gt',
    'lt',
    'in',
  ]),
  value: z.string().max(1000).transform(sanitizeString),
});

const ruleActionSchema = z.object({
  type: z.enum([
    'moveToFolder',
    'applyLabel',
    'markAsRead',
    'markAsUrgent',
    'forwardTo',
    'webhook',
    'sendTelegram',
    'sendWhatsApp',
  ]),
  config: z.record(z.string(), z.any()),
});

const createRuleSchema = z.object({
  name: z.string().min(1).max(200).transform(sanitizeString),
  description: z.string().max(1000).transform(sanitizeString).optional(),
  priority: z.number().int().default(0),
  conditions: z.array(ruleConditionSchema).min(1),
  actions: z.array(ruleActionSchema).min(1),
});

/**
 * GET /api/rules
 * List all rules for authenticated user, ordered by priority
 */
app.get(
  '/api/rules',
  requireAuth,
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      const userId = req.user?.userId;
      if (!userId) return res.status(401).json({ error: 'Unauthorized' });

      const rules = await prisma.rule.findMany({
        where: { userId },
        orderBy: { priority: 'desc' },
        include: {
          conditions: true,
          actions: true,
        },
      });

      return res.json(rules);
    } catch (error) {
      console.error('GET /api/rules error:', error);
      return res.status(500).json({ error: 'Failed to fetch rules' });
    }
  }
);

/**
 * POST /api/rules
 * Create a new rule with conditions and actions
 */
app.post(
  '/api/rules',
  requireAuth,
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      const userId = req.user?.userId;
      if (!userId) return res.status(401).json({ error: 'Unauthorized' });

      const validation = createRuleSchema.safeParse(req.body);
      if (!validation.success) {
        return res.status(400).json({
          error: 'Invalid request payload',
          details: validation.error.flatten(),
        });
      }

      const { name, description, priority, conditions, actions } =
        validation.data;

      const newRule = await prisma.rule.create({
        data: {
          userId,
          name,
          description,
          priority,
          conditions: {
            create: conditions,
          },
          actions: {
            create: actions as any,
          },
        },
        include: {
          conditions: true,
          actions: true,
        },
      });

      return res.status(201).json(newRule);
    } catch (error) {
      console.error('POST /api/rules error:', error);
      return res.status(500).json({ error: 'Failed to create rule' });
    }
  }
);

/**
 * GET /api/rules/:id
 * Retrieve single rule details
 */
app.get(
  '/api/rules/:id',
  requireAuth,
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      const userId = req.user?.userId;
      if (!userId) return res.status(401).json({ error: 'Unauthorized' });

      const id = req.params.id as string;

      // Validate UUID format
      const validation = schemas.uuid.safeParse(id);
      if (!validation.success) {
        return res.status(400).json({
          error: 'Invalid rule ID format',
          details: validation.error.flatten(),
        });
      }

      const rule = await prisma.rule.findUnique({
        where: { id: validation.data },
        include: {
          conditions: true,
          actions: true,
        },
      });

      if (!rule || rule.userId !== userId) {
        return res.status(404).json({ error: 'Rule not found' });
      }

      return res.json(rule);
    } catch (error) {
      console.error('GET /api/rules/:id error:', error);
      return res.status(500).json({ error: 'Failed to fetch rule' });
    }
  }
);

/**
 * PUT /api/rules/:id
 * Update rule by replacing conditions and actions
 */
app.put(
  '/api/rules/:id',
  requireAuth,
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      const userId = req.user?.userId;
      if (!userId) return res.status(401).json({ error: 'Unauthorized' });

      const id = req.params.id as string;

      // Validate UUID format
      const idValidation = schemas.uuid.safeParse(id);
      if (!idValidation.success) {
        return res.status(400).json({
          error: 'Invalid rule ID format',
          details: idValidation.error.flatten(),
        });
      }

      const existingRule = await prisma.rule.findUnique({
        where: { id: idValidation.data },
      });
      if (!existingRule || existingRule.userId !== userId) {
        return res.status(404).json({ error: 'Rule not found' });
      }

      const validation = createRuleSchema.safeParse(req.body);
      if (!validation.success) {
        return res.status(400).json({
          error: 'Invalid request payload',
          details: validation.error.flatten(),
        });
      }

      const { name, description, priority, conditions, actions } =
        validation.data;

      // Run delete-then-create inside a transaction
      const updatedRule = await prisma.$transaction(async (tx) => {
        await tx.ruleCondition.deleteMany({
          where: { ruleId: idValidation.data },
        });
        await tx.ruleAction.deleteMany({
          where: { ruleId: idValidation.data },
        });

        return tx.rule.update({
          where: { id: idValidation.data },
          data: {
            name,
            description,
            priority,
            conditions: {
              create: conditions,
            },
            actions: {
              create: actions as any,
            },
          },
          include: {
            conditions: true,
            actions: true,
          },
        });
      });

      return res.json(updatedRule);
    } catch (error) {
      console.error('PUT /api/rules/:id error:', error);
      return res.status(500).json({ error: 'Failed to update rule' });
    }
  }
);

/**
 * DELETE /api/rules/:id
 * Deletes a rule
 */
app.delete(
  '/api/rules/:id',
  requireAuth,
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      const userId = req.user?.userId;
      if (!userId) return res.status(401).json({ error: 'Unauthorized' });

      const id = req.params.id as string;

      // Validate UUID format
      const validation = schemas.uuid.safeParse(id);
      if (!validation.success) {
        return res.status(400).json({
          error: 'Invalid rule ID format',
          details: validation.error.flatten(),
        });
      }

      const rule = await prisma.rule.findUnique({
        where: { id: validation.data },
      });
      if (!rule || rule.userId !== userId) {
        return res.status(404).json({ error: 'Rule not found' });
      }

      await prisma.rule.delete({ where: { id: validation.data } });

      return res.json({ message: 'Rule deleted successfully' });
    } catch (error) {
      console.error('DELETE /api/rules/:id error:', error);
      return res.status(500).json({ error: 'Failed to delete rule' });
    }
  }
);

/**
 * POST /api/rules/:id/toggle
 * Toggles isActive status
 */
app.post(
  '/api/rules/:id/toggle',
  requireAuth,
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      const userId = req.user?.userId;
      if (!userId) return res.status(401).json({ error: 'Unauthorized' });

      const id = req.params.id as string;

      // Validate UUID format
      const validation = schemas.uuid.safeParse(id);
      if (!validation.success) {
        return res.status(400).json({
          error: 'Invalid rule ID format',
          details: validation.error.flatten(),
        });
      }

      const rule = await prisma.rule.findUnique({
        where: { id: validation.data },
      });
      if (!rule || rule.userId !== userId) {
        return res.status(404).json({ error: 'Rule not found' });
      }

      const updated = await prisma.rule.update({
        where: { id: validation.data },
        data: { isActive: !rule.isActive },
      });

      return res.json({
        message: 'Rule toggled successfully',
        isActive: updated.isActive,
      });
    } catch (error) {
      console.error('POST /api/rules/:id/toggle error:', error);
      return res.status(500).json({ error: 'Failed to toggle rule' });
    }
  }
);

/**
 * GET /api/auth/google
 * PUBLIC — Generates Google OAuth URL for sign-in/sign-up via Google.
 * No JWT required. The callback handles user creation automatically.
 */
app.get('/api/auth/google', (req: Request, res: Response) => {
  const url = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: [
      'https://mail.google.com/',
      'https://www.googleapis.com/auth/userinfo.email',
      'https://www.googleapis.com/auth/userinfo.profile',
    ],
    prompt: 'consent',
    state: 'google-signin', // special flag — callback will auto-create user
  });
  return res.json({ url });
});

/**
 * Handle security-related request errors without leaking internal details.
 */
app.use(
  (
    err: Error & { code?: string; type?: string },
    req: Request,
    res: Response,
    next: NextFunction
  ) => {
    if (err.code === 'CORS_NOT_ALLOWED') {
      return res.status(403).json({ error: 'Origin not allowed' });
    }

    if (err.type === 'entity.too.large') {
      const ip = req.ip || req.socket.remoteAddress || 'unknown';
      const cleanIp = Array.isArray(ip) ? ip[0] : ip;

      // Use standardized security event logging
      logger.warn('Request payload too large', {
        ip: cleanIp,
        path: req.path,
        method: req.method,
        limit: '10MB',
      });

      return res.status(413).json({
        error: 'Payload Too Large',
        message: 'Request body exceeds 10MB limit',
      });
    }
    next(err);
  }
);

// Start Server

const server = app.listen(PORT, () => {
  logger.info(`Auth service running on port ${PORT}`);

  // Register EventBus fallback handler AFTER server is listening
  // to avoid blocking startup if Redis is slow or unavailable.
  // This allows graceful degradation while the server remains responsive.
  EventBus.onFallback(() => {
    registerWorkerHandlers().catch((err) => {
      console.error(
        'Failed to register inline worker handlers on EventBus fallback:',
        err
      );
    });
  });

  // Initialize Telegram Bot Service
  TelegramBotService.init().catch((err) => {
    logger.error('Failed to initialize Telegram Bot Service:', err);
  });
});

// Initialize Socket.io Server with client-credentials CORS configuration
const io = new SocketIoServer(server, {
  cors: {
    origin: corsOrigin,
    credentials: true,
  },
});
WebSocketService.initialize(io);

// Graceful Shutdown hooks
const gracefulShutdown = () => {
  logger.info('Received shutdown signal. Starting graceful cleanup...');
  TelegramBotService.shutdown();
  server.close(() => {
    logger.info('HTTP server closed.');
    prisma.$disconnect().then(() => {
      logger.info('Prisma client disconnected. Exiting.');
      process.exit(0);
    });
  });
};

process.on('SIGTERM', gracefulShutdown);
process.on('SIGINT', gracefulShutdown);

export { app, server, prisma, io };
