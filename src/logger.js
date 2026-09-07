function format(message, details) {
  return details === undefined ? message : `${message} ${JSON.stringify(details)}`;
}
export const consoleLogger = {
  info: (message, details) => console.log(format(message, details)),
  warn: (message, details) => console.warn(format(message, details)),
  error: (message, details) => console.error(format(message, details)),
};
export const silentLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
};
