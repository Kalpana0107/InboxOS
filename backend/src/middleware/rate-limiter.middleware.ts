import { Request, Response } from 'express';
import { ipKeyGenerator, rateLimit } from 'express-rate-limit';
import RedisStore from 'rate-limit-redis';
import Redis from 'ioredis';
import { AuthService } from '../services/auth.service';
import { logger } from '../utils/logger';

const isTest = process.env.NODE_ENV === 'test';

// Initialize Redis client using container environment variable, fallback to default local Redis URL
const redisClient = !isTest
  ? new Redis(process.env.REDIS_URL || 'redis://redis:6379/0')
  : null;

const getClientIp = (req: Request): string =>
  req.ip || req.socket.remoteAddress || 'unknown';

/**
 * Global rate-limiting middleware for all /api endpoints.
 * Integrates with Redis to store request count across service restarts and scale-outs.
 */
export const rateLimiter = rateLimit({
  store: redisClient
    ? new RedisStore({
        // @ts-expect-error - compatibility mapping for ioredis and rate-limit-redis sendCommand structure
        sendCommand: (...args: string[]) =>
          redisClient.call(args[0], ...args.slice(1)),
      })
    : undefined, // Use default memory store in test env
  windowMs: 15 * 60 * 1000, // 15-minute window
  limit: async (req: Request) => {
    const token = req.cookies?.token;
    if (token) {
      try {
        const payload = AuthService.verifyToken(token);
        if (payload && payload.userId) {
          return 1000; // Authenticated user limit: 1000 requests per 15 mins
        }
      } catch (err) {
        // Fall back to public limits if token verification throws or is invalid
      }
    }
    return 100; // Public endpoint limit: 100 requests per 15 mins
  },
  keyGenerator: (req: Request) => {
    const token = req.cookies?.token;
    if (token) {
      try {
        const payload = AuthService.verifyToken(token);
        if (payload && payload.userId) {
          return `rate-limit:auth:${payload.userId}`;
        }
      } catch (err) {
        // Fall back to IP-based rate limiting key if token is malformed
      }
    }
    // Fallback to client IP address for public/anonymous requests
    return `rate-limit:public:${ipKeyGenerator(getClientIp(req))}`;
  },
  standardHeaders: true, // Return standard rate limit info in headers (RateLimit-*)
  legacyHeaders: true, // Include X-RateLimit-* headers
  handler: (req: Request, res: Response) => {
    res.status(429).json({ error: 'Too Many Requests' });
  },
});

/**
 * Global IP-based rate limiter middleware (separate from auth-based rate limiting).
 * Protects against brute force and DoS attacks by limiting requests per IP address.
 *
 * Configuration:
 * - 100 requests per 15 minute window per IP
 * - Uses Redis backend for distributed rate limiting
 * - Uses Express's proxy-aware client IP and normalizes IPv6 subnets
 * - Returns 429 with Retry-After header when limit exceeded
 * - Logs security events when rate limit is reached
 */
export const globalIpRateLimiter = rateLimit({
  store: redisClient
    ? new RedisStore({
        // @ts-expect-error - compatibility mapping for ioredis and rate-limit-redis sendCommand structure
        sendCommand: (...args: string[]) =>
          redisClient.call(args[0], ...args.slice(1)),
      })
    : undefined, // Use default memory store in test env
  windowMs: 15 * 60 * 1000, // 15 minutes
  limit: 100, // 100 requests per IP per window
  keyGenerator: (req: Request) =>
    `rate-limit:global-ip:${ipKeyGenerator(getClientIp(req))}`,
  standardHeaders: true, // Return RateLimit-* headers (draft-6 spec)
  legacyHeaders: true, // Include X-RateLimit-* headers for compatibility
  handler: (req: Request, res: Response) => {
    logger.warn('Rate limit exceeded', {
      ip: getClientIp(req),
      path: req.path,
      method: req.method,
      limit: 100,
      window: '15m',
    });

    const retryAfter = Math.ceil(15 * 60); // 15 minutes in seconds
    res.setHeader('Retry-After', retryAfter.toString());
    res.status(429).json({
      error: 'Too Many Requests',
      retryAfter: retryAfter,
    });
  },
});
