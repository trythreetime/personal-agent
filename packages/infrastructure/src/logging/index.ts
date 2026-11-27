import pino from 'pino';
export function createLogger() {
  return pino({
    level: 'info',
    redact: { paths: ['authorization', 'apiKey', 'password', 'token'], censor: '[REDACTED]' },
  });
}
