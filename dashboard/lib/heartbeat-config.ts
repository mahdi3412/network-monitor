// تنظیمات مرکزی heartbeat. سرور فاصله را به ایجنت‌ها اعلام می‌کند و
// آستانه وضعیت‌ها (آنلاین/اخیراً دیده‌شده/آفلاین) از همین فاصله ساخته می‌شود.

function numberEnv(name: string, fallback: number, min: number, max: number) {
  const value = Number(process.env[name]);
  if (!Number.isFinite(value) || value <= 0) return fallback;
  return Math.min(max, Math.max(min, value));
}

// فاصله heartbeat ایجنت‌ها (ثانیه)
export function heartbeatIntervalSeconds() {
  return numberEnv("HEARTBEAT_INTERVAL_SECONDS", 60, 10, 600);
}

// هر چند دقیقه یک‌بار (در صورت نبود تغییر) یک ردیف تاریخچه ذخیره شود
export function heartbeatHistoryMinutes() {
  return numberEnv("HEARTBEAT_HISTORY_MINUTES", 60, 1, 1440);
}

// مدت نگهداری تاریخچه heartbeat (روز)
export function heartbeatRetentionDays() {
  return numberEnv("HEARTBEAT_RETENTION_DAYS", 7, 1, 90);
}

export type ClientStatus = "online" | "recent" | "offline";

// آنلاین: تا ۳ برابر فاصله heartbeat، اخیراً دیده‌شده: تا ۱۰ برابر، بعد از آن آفلاین
export function clientStatus(ageMs: number): ClientStatus {
  const interval = heartbeatIntervalSeconds() * 1000;
  if (ageMs <= interval * 3) return "online";
  if (ageMs <= interval * 10) return "recent";
  return "offline";
}

export function clientStatusFromLastSeen(lastSeen: string | null | undefined, now = Date.now()): ClientStatus {
  const timestamp = lastSeen ? new Date(lastSeen).getTime() : NaN;
  if (!Number.isFinite(timestamp)) return "offline";
  return clientStatus(Math.max(0, now - timestamp));
}
