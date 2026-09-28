import sqlite3 from "sqlite3";
import path from "node:path";
import fs from "node:fs";

const dataDir = path.join(process.cwd(), "data");
fs.mkdirSync(dataDir, { recursive: true });

const db = new sqlite3.Database(path.join(dataDir, "network-monitor.db"));
let initialized = false;

export function all<T = any>(sql: string, params: any[] = []): Promise<T[]> {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (e, rows) => {
      if (e) reject(e);
      else resolve(rows as T[]);
    });
  });
}

export function run(sql: string, params: any[] = []): Promise<void> {
  return new Promise((resolve, reject) => {
    db.run(sql, params, (e) => {
      if (e) reject(e);
      else resolve();
    });
  });
}

export function transaction(statements: Array<{ sql: string; params?: any[] }>): Promise<void> {
  return new Promise((resolve, reject) => {
    db.serialize(() => {
      db.run("BEGIN TRANSACTION", (beginError) => {
        if (beginError) return reject(beginError);
        for (const statement of statements) {
          db.run(statement.sql, statement.params || [], (error) => {
            if (error) {
              db.run("ROLLBACK", () => reject(error));
            }
          });
        }
        db.run("COMMIT", (commitError) => commitError ? reject(commitError) : resolve());
      });
    });
  });
}

export function runWithId(sql: string, params: any[] = []): Promise<number> {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function (e) {
      if (e) reject(e);
      else resolve(this.lastID);
    });
  });
}

export async function initDb(): Promise<void> {
  if (initialized) return;

  await run(`CREATE TABLE IF NOT EXISTS clients (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    agent_id TEXT UNIQUE NOT NULL,
    ip TEXT,
    mac TEXT,
    hostname TEXT,
    username TEXT,
    first_name TEXT,
    last_name TEXT,
    personnel_id TEXT,
    os TEXT,
    os_version TEXT,
    cpu TEXT,
    ram_mb INTEGER,
    gateway TEXT,
    dns TEXT,
    adapter TEXT,
    agent_version TEXT,
    last_seen TEXT NOT NULL,
    created_at TEXT NOT NULL,
    api_key_hash TEXT
  )`);

  await run(`CREATE TABLE IF NOT EXISTS heartbeats (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    agent_id TEXT NOT NULL,
    ip TEXT,
    hostname TEXT,
    username TEXT,
    received_at TEXT NOT NULL,
    latency_ms INTEGER
  )`);

  await run(`CREATE TABLE IF NOT EXISTS network_scan_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    started_at TEXT NOT NULL,
    finished_at TEXT,
    status TEXT NOT NULL,
    scanned_ranges INTEGER NOT NULL DEFAULT 0,
    discovered_hosts INTEGER NOT NULL DEFAULT 0,
    skipped_ranges INTEGER NOT NULL DEFAULT 0,
    error TEXT
  )`);

  await run(`CREATE TABLE IF NOT EXISTS network_ranges (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    agent_id TEXT NOT NULL,
    subnet TEXT NOT NULL,
    source TEXT NOT NULL DEFAULT 'observed',
    first_seen TEXT NOT NULL,
    last_seen TEXT NOT NULL,
    UNIQUE(agent_id, subnet)
  )`);

  await run(`CREATE TABLE IF NOT EXISTS network_hosts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    agent_id TEXT NOT NULL,
    ip TEXT NOT NULL,
    hostname TEXT,
    username TEXT,
    mac TEXT,
    adapter TEXT,
    subnet TEXT,
    method TEXT,
    device_type TEXT,
    services TEXT,
    latency_ms INTEGER,
    reachable INTEGER NOT NULL,
    scanned_at TEXT NOT NULL,
    first_seen TEXT NOT NULL,
    last_seen TEXT NOT NULL,
    UNIQUE(agent_id, ip)
  )`);

  await run(`CREATE TABLE IF NOT EXISTS directory_computers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT UNIQUE NOT NULL,
    dns_host_name TEXT,
    operating_system TEXT,
    operating_system_version TEXT,
    description TEXT,
    managed_by TEXT,
    distinguished_name TEXT,
    last_sync TEXT NOT NULL
  )`);

  await run(`CREATE TABLE IF NOT EXISTS directory_users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    personnel_id TEXT UNIQUE NOT NULL,
    username TEXT,
    user_principal_name TEXT,
    display_name TEXT,
    first_name TEXT,
    last_name TEXT,
    department TEXT,
    title TEXT,
    email TEXT,
    distinguished_name TEXT,
    last_sync TEXT NOT NULL
  )`);

  const clients = await all<any>("PRAGMA table_info(clients)");
  if (!clients.some((column) => column.name === "api_key_hash")) {
    await run("ALTER TABLE clients ADD COLUMN api_key_hash TEXT");
  }

  const heartbeats = await all<any>("PRAGMA table_info(heartbeats)");
  if (!heartbeats.some((column) => column.name === "latency_ms")) {
    await run("ALTER TABLE heartbeats ADD COLUMN latency_ms INTEGER");
  }

  const networkHosts = await all<any>("PRAGMA table_info(network_hosts)");
  const additions: Promise<void>[] = [];

  if (!networkHosts.some((column) => column.name === "username")) {
    additions.push(run("ALTER TABLE network_hosts ADD COLUMN username TEXT"));
  }
  if (!networkHosts.some((column) => column.name === "mac")) {
    additions.push(run("ALTER TABLE network_hosts ADD COLUMN mac TEXT"));
  }
  if (!networkHosts.some((column) => column.name === "adapter")) {
    additions.push(run("ALTER TABLE network_hosts ADD COLUMN adapter TEXT"));
  }
  if (!networkHosts.some((column) => column.name === "subnet")) {
    additions.push(run("ALTER TABLE network_hosts ADD COLUMN subnet TEXT"));
  }
  if (!networkHosts.some((column) => column.name === "method")) {
    additions.push(run("ALTER TABLE network_hosts ADD COLUMN method TEXT"));
  }
  if (!networkHosts.some((column) => column.name === "device_type")) {
    additions.push(run("ALTER TABLE network_hosts ADD COLUMN device_type TEXT"));
  }
  if (!networkHosts.some((column) => column.name === "services")) {
    additions.push(run("ALTER TABLE network_hosts ADD COLUMN services TEXT"));
  }
  if (!networkHosts.some((column) => column.name === "first_seen")) {
    additions.push(run("ALTER TABLE network_hosts ADD COLUMN first_seen TEXT"));
  }
  if (!networkHosts.some((column) => column.name === "last_seen")) {
    additions.push(run("ALTER TABLE network_hosts ADD COLUMN last_seen TEXT"));
  }

  await Promise.all(additions);
  await run("UPDATE network_hosts SET first_seen=COALESCE(first_seen, scanned_at), last_seen=COALESCE(last_seen, scanned_at)");
  await run("CREATE INDEX IF NOT EXISTS idx_network_hosts_last_seen ON network_hosts(last_seen)");
  await run("CREATE INDEX IF NOT EXISTS idx_network_scan_runs_started_at ON network_scan_runs(started_at)");
  await run("CREATE INDEX IF NOT EXISTS idx_network_hosts_subnet_last_seen ON network_hosts(subnet,last_seen)");
  await run("CREATE INDEX IF NOT EXISTS idx_network_ranges_last_seen ON network_ranges(last_seen)");
  await run("CREATE INDEX IF NOT EXISTS idx_directory_users_username ON directory_users(username)");
  await run("CREATE INDEX IF NOT EXISTS idx_directory_computers_dns ON directory_computers(dns_host_name)");
  await run("CREATE INDEX IF NOT EXISTS idx_directory_computers_name ON directory_computers(name)");
  await run("INSERT OR IGNORE INTO network_ranges(agent_id,subnet,source,first_seen,last_seen) SELECT agent_id,subnet,'observed',MIN(first_seen),MAX(last_seen) FROM network_hosts WHERE subnet<>'' GROUP BY agent_id,subnet");
  initialized = true;
}
