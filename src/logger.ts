type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_RANK: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

const currentLevel = (): LogLevel => {
  const env = process.env.LOG_LEVEL?.toLowerCase();
  if (env === 'debug' || env === 'info' || env === 'warn' || env === 'error') {
    return env;
  }
  return 'info';
};

interface LogPayload {
  timestamp: string;
  level: LogLevel;
  source: string;
  message: string;
  [key: string]: unknown;
}

const emit = (level: LogLevel, source: string, message: string, extra?: Record<string, unknown>): void => {
  if (LEVEL_RANK[level] < LEVEL_RANK[currentLevel()]) return;
  const payload: LogPayload = {
    timestamp: new Date().toISOString(),
    level,
    source,
    message,
    ...extra,
  };
  const line = JSON.stringify(payload);
  if (level === 'error') {
    console.error(line);
  } else {
    console.log(line);
  }
};

export const logger = {
  debug: (source: string, message: string, extra?: Record<string, unknown>): void =>
    emit('debug', source, message, extra),
  info: (source: string, message: string, extra?: Record<string, unknown>): void =>
    emit('info', source, message, extra),
  warn: (source: string, message: string, extra?: Record<string, unknown>): void =>
    emit('warn', source, message, extra),
  error: (source: string, message: string, extra?: Record<string, unknown>): void =>
    emit('error', source, message, extra),
};
