type LogLevel = 'info' | 'warn' | 'error' | 'debug';

interface LogContext {
  module?: string;
  symbol?: string;
  [key: string]: unknown;
}

const isDev = process.env.NODE_ENV !== 'production';

function log(level: LogLevel, message: string, context?: LogContext) {
  if (isDev) {
    const prefix = context?.module ? `[${context.module}]` : '';
    const method = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;
    method(`${prefix} ${message}`, context ? { ...context, module: undefined } : '');
    return;
  }

  // Structured JSON in production
  const entry = {
    level,
    message,
    timestamp: new Date().toISOString(),
    ...context,
  };
  const method = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;
  method(JSON.stringify(entry));
}

export const logger = {
  info: (message: string, context?: LogContext) => log('info', message, context),
  warn: (message: string, context?: LogContext) => log('warn', message, context),
  error: (message: string, context?: LogContext) => log('error', message, context),
  debug: (message: string, context?: LogContext) => log('debug', message, context),
};
