// pino logger: pretty in dev, JSON in production (per HANDOVER.md).

import { pino, type Logger } from "pino";

export function buildLogger(nodeEnv: string): Logger {
  if (nodeEnv === "production") {
    return pino({ level: process.env.LOG_LEVEL ?? "info" });
  }
  return pino({
    level: process.env.LOG_LEVEL ?? (nodeEnv === "test" ? "silent" : "debug"),
    transport:
      nodeEnv === "test"
        ? undefined
        : { target: "pino-pretty", options: { translateTime: "HH:MM:ss", ignore: "pid,hostname" } },
  });
}
