import { z } from 'zod';
import sanitizeHtmlLibrary from 'sanitize-html';

/**
 * Email validation schema (RFC 5322 compliant)
 * Maximum length of 254 characters as per RFC 5321
 */
export const emailSchema = z.string().email().max(254);

/**
 * URL validation schema with protocol whitelist
 * Only allows HTTP and HTTPS protocols to reject unsafe URL schemes
 */
export const urlSchema = z
  .string()
  .url()
  .refine(
    (url) => {
      try {
        const parsed = new URL(url);
        return ['http:', 'https:'].includes(parsed.protocol);
      } catch {
        return false;
      }
    },
    { message: 'Only HTTP and HTTPS URLs are allowed' }
  );

/**
 * Sanitize HTML content to prevent XSS attacks
 * Allows only safe HTML tags and attributes
 *
 * @param html - Raw HTML string to sanitize
 * @returns Sanitized HTML string with only allowed tags and attributes
 */
export function sanitizeHtml(html: string): string {
  return sanitizeHtmlLibrary(html, {
    allowedTags: [
      'p',
      'br',
      'strong',
      'em',
      'u',
      'a',
      'ul',
      'ol',
      'li',
      'h1',
      'h2',
      'h3',
      'h4',
      'h5',
      'h6',
      'blockquote',
      'code',
      'pre',
    ],
    allowedAttributes: {
      a: ['href', 'title'],
    },
  });
}

/**
 * Sanitize user input strings by removing potentially dangerous characters
 * Trims whitespace and removes characters commonly used in injection attacks
 *
 * @param input - Raw string input
 * @returns Sanitized string with dangerous characters removed and length limited
 */
export function sanitizeString(input: string): string {
  return input
    .trim()
    .replace(/[<>'"]/g, '') // Remove potentially dangerous characters
    .substring(0, 1000); // Limit length to prevent abuse
}

/**
 * Subject line validation schema
 * Maximum length of 998 characters as per RFC 5322
 * Applies sanitization to remove dangerous characters
 */
export const subjectSchema = z
  .string()
  .min(1)
  .max(998)
  .transform(sanitizeString);

/**
 * Email body validation schema
 * Maximum length of 10MB to match the API request limit.
 */
export const bodySchema = z.string().max(10 * 1024 * 1024);

/**
 * Message ID validation schema
 * Allows only alphanumeric characters and common email message ID characters
 */
export const messageIdSchema = z
  .string()
  .regex(/^[a-zA-Z0-9@.<>_-]+$/, 'Invalid message ID format');

/**
 * UUID validation schema
 * Validates standard UUID format (v4)
 */
export const uuidSchema = z.string().uuid();

/**
 * Common validation schemas for reuse across the application
 * Export as a single object for convenient imports
 */
export const schemas = {
  email: emailSchema,
  url: urlSchema,
  subject: subjectSchema,
  body: bodySchema,
  messageId: messageIdSchema,
  uuid: uuidSchema,
};
