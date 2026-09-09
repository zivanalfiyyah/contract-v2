import pino from "pino";

// Structured logging — replaces scattered console.log/error calls so
// production issues can be diagnosed from log output alone (level,
// timestamp, and in the HTTP middleware's case a per-request id to
// correlate a failure with the exact request that caused it), without
// needing shell access to the server.
//
// Development: human-readable, colorized (via pino-pretty).
// Production: plain JSON lines — the format log aggregators (CloudWatch,
// Datadog, Loki, etc.) expect, not something meant to be read directly.
const isProduction = process.env.NODE_ENV === "production";

export const logger = pino({
  level: process.env.LOG_LEVEL || (isProduction ? "info" : "debug"),
  transport: isProduction
    ? undefined
    : {
        target: "pino-pretty",
        options: { colorize: true, translateTime: "HH:MM:ss", ignore: "pid,hostname" },
      },
});
