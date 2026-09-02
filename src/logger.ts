/** Minimal logging seam — injectable so tests stay silent. */
export interface Logger {
  info(message: string, details?: Record<string, unknown>): void;
  warn(message: string, details?: Record<string, unknown>): void;
  error(message: string, details?: Record<string, unknown>): void;
}

function format(message: string, details?: Record<string, unknown>): string {
  return details === undefined ? message : `${message} ${JSON.stringify(details)}`;
}

export const consoleLogger: Logger = {
  info: (message, details) => console.log(format(message, details)),
  warn: (message, details) => console.warn(format(message, details)),
  error: (message, details) => console.error(format(message, details)),
};

export const silentLogger: Logger = {
  info: () => {},
  warn: () => {},
  error: () => {},
};
