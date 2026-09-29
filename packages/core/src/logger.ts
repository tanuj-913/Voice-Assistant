import { pino, type Logger } from 'pino';

export type { Logger };

const isDev = process.env.NODE_ENV !== 'production';

export const logger: Logger = pino({
  level: process.env.LOG_LEVEL ?? 'info',
  // Never let an API key reach the log file.
  redact: {
    paths: [
      'apiKey',
      'api_key',
      '*.apiKey',
      'headers["api-subscription-key"]',
      'headers.authorization',
      'SARVAM_API_KEY',
      'SERPER_API_KEY',
    ],
    censor: '[redacted]',
  },
  ...(isDev
    ? {
        transport: {
          target: 'pino-pretty',
          options: { colorize: true, translateTime: 'HH:MM:ss.l', ignore: 'pid,hostname' },
        },
      }
    : {}),
});

export const childLogger = (component: string): Logger => logger.child({ component });
