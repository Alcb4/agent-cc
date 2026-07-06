export const SUPERVISOR_URL =
  process.env.NEXT_PUBLIC_SUPERVISOR_URL ?? "http://localhost:7711";

export const SUPERVISOR_WS =
  SUPERVISOR_URL.replace(/^http/, "ws");
