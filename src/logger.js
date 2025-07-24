const LOG_LEVEL = {
  DEBUG: 0,
  INFO: 1,
  WARN: 2,
  ERROR: 3,
  NONE: 4,
};

const CURRENT_LOG_LEVEL = LOG_LEVEL.DEBUG;

const log = (level, ...args) => {
  if (level >= CURRENT_LOG_LEVEL) {
    const timestamp = new Date().toISOString();
    switch (level) {
      case LOG_LEVEL.DEBUG:
        console.debug(`[${timestamp}] [DEBUG]`, ...args);
        break;
      case LOG_LEVEL.INFO:
        console.info(`[${timestamp}] [INFO]`, ...args);
        break;
      case LOG_LEVEL.WARN:
        console.warn(`[${timestamp}] [WARN]`, ...args);
        break;
      case LOG_LEVEL.ERROR:
        console.error(`[${timestamp}] [ERROR]`, ...args);
        break;
      default:
        break;
    }
  }
};

export const logger = {
  debug: (...args) => log(LOG_LEVEL.DEBUG, ...args),
  info: (...args) => log(LOG_LEVEL.INFO, ...args),
  warn: (...args) => log(LOG_LEVEL.WARN, ...args),
  error: (...args) => log(LOG_LEVEL.ERROR, ...args),
};
