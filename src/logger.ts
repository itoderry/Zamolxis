import { pino } from 'pino';

const level = process.env.ZAMOLXIS_LOG_LEVEL ?? 'info';

// Pretty logs only for an interactive terminal. Under a service / pm2 / piped
// output (no TTY) or in production, emit plain JSON — it never drops lines on
// a fast exit the way the pino-pretty worker can.
const pretty = process.stdout.isTTY && process.env.NODE_ENV !== 'production';

export const logger = pino({
  level,
  transport: pretty
    ? { target: 'pino-pretty', options: { colorize: true, translateTime: 'HH:MM:ss', ignore: 'pid,hostname' } }
    : undefined,
});

export type Logger = typeof logger;
