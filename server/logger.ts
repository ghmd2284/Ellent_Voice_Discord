export const logger = {
  format: (level: string, message: string) => {
    const timestamp = new Date().toISOString();
    return `[${timestamp}] [${level}] ${message}`;
  },
  info: (message: string) => console.log(logger.format('INFO', message)),
  warn: (message: string) => console.warn(logger.format('WARN', message)),
  error: (message: string, err?: any) => {
    console.error(logger.format('ERROR', message), err || '');
  },
  debug: (message: string) => {
    if (process.env.DEBUG) console.log(logger.format('DEBUG', message));
  }
};
