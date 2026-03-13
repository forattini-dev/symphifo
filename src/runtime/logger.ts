import pino from "pino";
import { env, stdout } from "node:process";
import { join } from "node:path";

const level = env.SYMPHIFO_LOG_LEVEL ?? "info";
const pretty = env.SYMPHIFO_LOG_PRETTY === "1" || (env.SYMPHIFO_LOG_PRETTY !== "0" && stdout.isTTY);

// Propagate pretty preference to s3db.js internal logger
// so its pino output matches ours (must be set before s3db loads)
if (!env.S3DB_LOG_FORMAT && !env.S3DB_LOG_PRETTY) {
  env.S3DB_LOG_PRETTY = pretty ? "true" : "false";
}
if (!env.S3DB_LOG_LEVEL) {
  env.S3DB_LOG_LEVEL = level;
}

function createTransports(logPath?: string) {
  const targets: pino.TransportTargetOptions[] = [];

  if (pretty) {
    targets.push({
      target: "pino-pretty",
      options: { colorize: true, translateTime: "HH:MM:ss.l", ignore: "pid,hostname" },
      level,
    });
  } else {
    targets.push({
      target: "pino/file",
      options: { destination: 1 },
      level,
    });
  }

  if (logPath) {
    targets.push({
      target: "pino/file",
      options: { destination: logPath, mkdir: true },
      level,
    });
  }

  return pino.transport({ targets });
}

let _logger: pino.Logger | null = null;
let _logPath: string | undefined;

export function initLogger(stateRoot?: string): pino.Logger {
  _logPath = stateRoot ? join(stateRoot, "symphifo-local.log") : undefined;
  _logger = pino({ name: "symphifo", level }, createTransports(_logPath));
  return _logger;
}

export function getLogger(): pino.Logger {
  if (!_logger) {
    _logger = pino({ name: "symphifo", level }, createTransports());
  }
  return _logger;
}

export const logger = {
  get info() { return getLogger().info.bind(getLogger()); },
  get warn() { return getLogger().warn.bind(getLogger()); },
  get error() { return getLogger().error.bind(getLogger()); },
  get debug() { return getLogger().debug.bind(getLogger()); },
  get fatal() { return getLogger().fatal.bind(getLogger()); },
  get child() { return getLogger().child.bind(getLogger()); },
};
