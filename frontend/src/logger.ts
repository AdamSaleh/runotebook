export enum LogLevel {
  TRACE = 0,
  DEBUG = 1,
  INFO = 2,
  WARN = 3,
  ERROR = 4,
}

let currentLogLevel = LogLevel.DEBUG;
let remoteLoggingEnabled = true;

// Queue for logs before page is fully loaded
const pendingLogs: Array<{ level: string; message: string; timestamp: string }> = [];
let flushScheduled = false;

function getTimestamp(): string {
  return new Date().toISOString().substr(11, 12);
}

function sendToServer(level: string, message: string, timestamp: string): void {
  if (!remoteLoggingEnabled) return;

  pendingLogs.push({ level, message, timestamp });

  if (!flushScheduled) {
    flushScheduled = true;
    // Batch logs and send after a small delay
    setTimeout(flushLogs, 50);
  }
}

function flushLogs(): void {
  flushScheduled = false;
  if (pendingLogs.length === 0) return;

  const logsToSend = pendingLogs.splice(0, pendingLogs.length);

  // Send each log (could batch into array endpoint if needed)
  for (const log of logsToSend) {
    fetch('/api/console', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(log),
    }).catch(() => {
      // Silently ignore fetch errors to avoid infinite loops
    });
  }
}

function formatArgs(args: unknown[]): string {
  return args
    .map((arg) => {
      if (typeof arg === 'string') return arg;
      if (arg instanceof Error) return `${arg.name}: ${arg.message}\n${arg.stack || ''}`;
      try {
        return JSON.stringify(arg);
      } catch {
        return String(arg);
      }
    })
    .join(' ');
}

export function setLogLevel(level: LogLevel): void {
  currentLogLevel = level;
}

export function setRemoteLogging(enabled: boolean): void {
  remoteLoggingEnabled = enabled;
}

export function log(level: LogLevel, ...args: unknown[]): void {
  if (level >= currentLogLevel) {
    const timestamp = getTimestamp();
    const levelName = LogLevel[level].toLowerCase();
    const prefix = `[${timestamp}] [${levelName.toUpperCase()}]`;
    const message = formatArgs(args);

    // Send to server
    sendToServer(levelName, message, timestamp);

    // Also log to local console
    switch (level) {
      case LogLevel.ERROR:
        console.error(prefix, ...args);
        break;
      case LogLevel.WARN:
        console.warn(prefix, ...args);
        break;
      case LogLevel.INFO:
        console.info(prefix, ...args);
        break;
      default:
        console.log(prefix, ...args);
    }
  }
}

export const logger = {
  trace: (...args: unknown[]) => log(LogLevel.TRACE, ...args),
  debug: (...args: unknown[]) => log(LogLevel.DEBUG, ...args),
  info: (...args: unknown[]) => log(LogLevel.INFO, ...args),
  warn: (...args: unknown[]) => log(LogLevel.WARN, ...args),
  error: (...args: unknown[]) => log(LogLevel.ERROR, ...args),
};

// Intercept native console methods to capture all logs
const originalConsole = {
  log: console.log.bind(console),
  info: console.info.bind(console),
  warn: console.warn.bind(console),
  error: console.error.bind(console),
  debug: console.debug.bind(console),
};

function interceptConsole(): void {
  console.log = (...args: unknown[]) => {
    sendToServer('debug', formatArgs(args), getTimestamp());
    originalConsole.log(...args);
  };

  console.info = (...args: unknown[]) => {
    sendToServer('info', formatArgs(args), getTimestamp());
    originalConsole.info(...args);
  };

  console.warn = (...args: unknown[]) => {
    sendToServer('warn', formatArgs(args), getTimestamp());
    originalConsole.warn(...args);
  };

  console.error = (...args: unknown[]) => {
    sendToServer('error', formatArgs(args), getTimestamp());
    originalConsole.error(...args);
  };

  console.debug = (...args: unknown[]) => {
    sendToServer('debug', formatArgs(args), getTimestamp());
    originalConsole.debug(...args);
  };
}

// Also capture unhandled errors and promise rejections
function setupErrorHandlers(): void {
  window.addEventListener('error', (event) => {
    const message = `Uncaught ${event.error?.name || 'Error'}: ${event.message} at ${event.filename}:${event.lineno}:${event.colno}`;
    sendToServer('error', message, getTimestamp());
  });

  window.addEventListener('unhandledrejection', (event) => {
    const reason = event.reason instanceof Error
      ? `${event.reason.name}: ${event.reason.message}`
      : String(event.reason);
    sendToServer('error', `Unhandled Promise Rejection: ${reason}`, getTimestamp());
  });
}

// Initialize interception
interceptConsole();
setupErrorHandlers();
