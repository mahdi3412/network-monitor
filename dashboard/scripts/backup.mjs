// بکاپ دیتابیس SQLite (VACUUM INTO: سازگار و بدون قفل طولانی) و نگهداری N بکاپ آخر.
// اجرا از ریشه پروژه:  node dashboard/scripts/backup.mjs
// متغیرهای اختیاری: BACKUP_DIR (پیش‌فرض data/backups) و BACKUP_KEEP (پیش‌فرض ۱۴)
import sqlite3 from "sqlite3";
import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const dbFile = path.join(root, "data", "network-monitor.db");
const dir = process.env.BACKUP_DIR || path.join(root, "data", "backups");
const keep = Math.max(1, Number(process.env.BACKUP_KEEP || 14));

if (!fs.existsSync(dbFile)) {
  console.error(`Database not found: ${dbFile}`);
  process.exit(1);
}

fs.mkdirSync(dir, { recursive: true });

const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..+/, "").replace("T", "-");
const target = path.join(dir, `network-monitor-${stamp}.sqlite`);

const db = new sqlite3.Database(dbFile);
db.run("VACUUM INTO ?", [target], (error) => {
  db.close();
  if (error) {
    console.error("Backup failed:", error.message);
    process.exit(1);
  }

  const backups = fs
    .readdirSync(dir)
    .filter((name) => /^network-monitor-\d{8}-\d{6}\.sqlite$/.test(name))
    .sort();
  for (const old of backups.slice(0, Math.max(0, backups.length - keep))) {
    fs.unlinkSync(path.join(dir, old));
  }

  console.log(`Backup created: ${target} (kept ${Math.min(backups.length, keep)})`);
});
