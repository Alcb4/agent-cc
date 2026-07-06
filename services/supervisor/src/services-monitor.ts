// Periodic liveness probe for the services the supervisor depends on. A startup
// probe is not enough (Risk 3): a service can report healthy once and then fail
// every call. This probes /health on an interval and exposes the live status so
// the dashboard can show a hard-fail banner instead of silently degrading.

import type { Logger } from "pino";

export interface ServiceTarget {
  name: string;
  url: string;
}

export interface ServiceStatus {
  name: string;
  url: string;
  status: "up" | "down" | "unknown";
  lastError: string | null;
  lastCheck: string | null;
}

const PROBE_INTERVAL_MS = 10_000;
const PROBE_TIMEOUT_MS = 2_000;

export class ServiceMonitor {
  private state = new Map<string, ServiceStatus>();
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly targets: ServiceTarget[],
    private readonly log: Logger,
  ) {
    for (const t of targets) {
      this.state.set(t.name, { name: t.name, url: t.url, status: "unknown", lastError: null, lastCheck: null });
    }
  }

  start(): void {
    if (this.timer) return;
    void this.probeAll();
    this.timer = setInterval(() => void this.probeAll(), PROBE_INTERVAL_MS);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  snapshot(): ServiceStatus[] {
    return [...this.state.values()];
  }

  private async probeAll(): Promise<void> {
    await Promise.all(this.targets.map((t) => this.probe(t)));
  }

  private async probe(t: ServiceTarget): Promise<void> {
    const prev = this.state.get(t.name)?.status;
    const now = new Date().toISOString();
    try {
      const res = await fetch(`${t.url}/health`, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      this.state.set(t.name, { name: t.name, url: t.url, status: "up", lastError: null, lastCheck: now });
      if (prev === "down") this.log.info({ service: t.name }, "service recovered");
    } catch (e) {
      const lastError = e instanceof Error ? e.message : String(e);
      this.state.set(t.name, { name: t.name, url: t.url, status: "down", lastError, lastCheck: now });
      if (prev !== "down") this.log.warn({ service: t.name, err: lastError }, "service is down");
    }
  }
}
