import sqlite3 from "sqlite3";
import path from "path";
import fs from "fs";
const dataDir=path.join(process.cwd(),"data");fs.mkdirSync(dataDir,{recursive:true});
const db=new sqlite3.Database(path.join(dataDir,"network-monitor.db"));let initialized=false;
export function initDb():Promise<void>{if(initialized)return Promise.resolve();return new Promise((resolve,reject)=>db.serialize(()=>{
db.run(`CREATE TABLE IF NOT EXISTS clients (id INTEGER PRIMARY KEY AUTOINCREMENT,agent_id TEXT UNIQUE NOT NULL,ip TEXT,mac TEXT,hostname TEXT,username TEXT,first_name TEXT,last_name TEXT,personnel_id TEXT,os TEXT,os_version TEXT,cpu TEXT,ram_mb INTEGER,gateway TEXT,dns TEXT,adapter TEXT,agent_version TEXT,last_seen TEXT NOT NULL,created_at TEXT NOT NULL,api_key_hash TEXT)`,e=>{if(e)return reject(e);
db.run(`CREATE TABLE IF NOT EXISTS heartbeats (id INTEGER PRIMARY KEY AUTOINCREMENT,agent_id TEXT NOT NULL,ip TEXT,hostname TEXT,username TEXT,received_at TEXT NOT NULL,latency_ms INTEGER)`,e2=>{if(e2)return reject(e2);
db.run(`CREATE TABLE IF NOT EXISTS network_hosts (id INTEGER PRIMARY KEY AUTOINCREMENT,agent_id TEXT NOT NULL,ip TEXT NOT NULL,hostname TEXT,latency_ms INTEGER,reachable INTEGER NOT NULL,scanned_at TEXT NOT NULL,UNIQUE(agent_id,ip))`,e3=>{if(e3)return reject(e3);
db.all("PRAGMA table_info(clients)",(e4,columns:any[])=>{if(e4)return reject(e4);const addApiKey=columns.some(c=>c.name==="api_key_hash")?Promise.resolve():run("ALTER TABLE clients ADD COLUMN api_key_hash TEXT");
db.all("PRAGMA table_info(heartbeats)",(e5,hb:any[])=>{if(e5)return reject(e5);const addLatency=hb.some(c=>c.name==="latency_ms")?Promise.resolve():run("ALTER TABLE heartbeats ADD COLUMN latency_ms INTEGER");
Promise.all([addApiKey,addLatency]).then(()=>{initialized=true;resolve()}).catch(reject)})})})})})})}
export function all<T=any>(sql:string,params:any[]=[]):Promise<T[]>{return new Promise((resolve,reject)=>db.all(sql,params,(e,r)=>e?reject(e):resolve(r as T[])))}
export function run(sql:string,params:any[]=[]):Promise<void>{return new Promise((resolve,reject)=>db.run(sql,params,e=>e?reject(e):resolve()))}
