// Minimal 5-field cron support for the N3 scheduler (min hour dom month dow),
// evaluated in server local time. Supports `*`, lists `a,b`, ranges `a-b`, and
// steps `*/n` / `a-b/n`. No dependency — checked once a minute is plenty.

const FIELD_RE = /^(\*|\d+(-\d+)?)(\/\d+)?(,(\*|\d+(-\d+)?)(\/\d+)?)*$/;

export function validateCron(expr: string): boolean {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) return false;
  return parts.every((p) => FIELD_RE.test(p));
}

function fieldMatch(field: string, val: number, lo: number, hi: number): boolean {
  for (const part of field.split(",")) {
    let range = part;
    let step = 1;
    const slash = part.split("/");
    if (slash.length === 2) {
      range = slash[0]!;
      step = parseInt(slash[1]!, 10) || 1;
    }
    let start = lo;
    let end = hi;
    if (range !== "*") {
      const dash = range.split("-");
      start = parseInt(dash[0]!, 10);
      end = dash.length === 2 ? parseInt(dash[1]!, 10) : start;
    }
    for (let v = start; v <= end; v += step) {
      if (v === val) return true;
    }
  }
  return false;
}

// Does `expr` match the given time? (minute granularity, local time)
export function cronMatches(expr: string, date: Date): boolean {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) return false;
  const [min, hr, dom, mon, dow] = parts as [string, string, string, string, string];
  return (
    fieldMatch(min, date.getMinutes(), 0, 59) &&
    fieldMatch(hr, date.getHours(), 0, 23) &&
    fieldMatch(dom, date.getDate(), 1, 31) &&
    fieldMatch(mon, date.getMonth() + 1, 1, 12) &&
    fieldMatch(dow, date.getDay(), 0, 6)
  );
}

// Minute key "YYYY-MM-DDTHH:MM" — used to fire a schedule at most once per minute.
export function minuteKey(date: Date): string {
  return date.toISOString().slice(0, 16);
}
