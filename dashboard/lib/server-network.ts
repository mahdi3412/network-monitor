import { execFile } from "child_process";
import { promisify } from "util";
import os from "os";

const execFileAsync = promisify(execFile);

function ipv4ToInt(ip: string) {
  return ip.split(".").reduce((n, octet) => (n << 8) + Number(octet), 0) >>> 0;
}

function intToIpv4(value: number) {
  return [(value >>> 24) & 255, (value >>> 16) & 255, (value >>> 8) & 255, value & 255].join(".");
}

function maskToPrefix(mask: string) {
  const bits = mask.split(".").map(Number);
  if (bits.length !== 4 || bits.some((n) => n < 0 || n > 255)) return null;
  let binary = "";
  for (const n of bits) binary += n.toString(2).padStart(8, "0");
  const firstZero = binary.indexOf("0");
  if (firstZero === -1) return 32;
  if (binary.slice(firstZero).includes("1")) return null;
  return firstZero;
}

function normalize(ip: string, prefix: number) {
  if (!/^\d+\.\d+\.\d+\.\d+$/.test(ip) || prefix < 1 || prefix > 32) return null;
  const mask = prefix === 32 ? 0xffffffff : (0xffffffff << (32 - prefix)) >>> 0;
  return intToIpv4((ipv4ToInt(ip) & mask) >>> 0) + "/" + prefix;
}

export async function detectServerIpv4Ranges(): Promise<string[]> {
  const values = new Set<string>();

  for (const item of Object.values(os.networkInterfaces())) {
    for (const iface of item || []) {
      if (iface.family === "IPv4" && !iface.internal && iface.address && iface.netmask) {
        const prefix = maskToPrefix(iface.netmask);
        if (prefix != null && prefix >= 16 && prefix < 31) {
          const subnet = normalize(iface.address, prefix);
          if (subnet) values.add(subnet);
        }
      }
    }
  }

  try {
    if (process.platform === "win32") {
      const { stdout } = await execFileAsync("route", ["print", "-4"], { windowsHide: true, timeout: 3000 });
      for (const line of String(stdout || "").split(/\r?\n/)) {
        const m = line.trim().match(/^(\d+\.\d+\.\d+\.\d+)\s+(\d+\.\d+\.\d+\.\d+)\s+(\d+\.\d+\.\d+\.\d+)\s+(\d+\.\d+\.\d+\.\d+)\s+\d+$/);
        if (!m || m[1] === "0.0.0.0") continue;
        const prefix = maskToPrefix(m[2]);
        if (prefix == null || prefix < 16 || prefix > 30) continue;
        const subnet = normalize(m[1], prefix);
        if (subnet) values.add(subnet);
      }
    } else {
      const { stdout } = await execFileAsync("ip", ["-4", "route"], { timeout: 3000 });
      for (const line of String(stdout || "").split(/\r?\n/)) {
        const m = line.trim().match(/^(\d+\.\d+\.\d+\.\d+\/\d+)\b/);
        if (!m) continue;
        const [ip, prefixText] = m[1].split("/");
        const prefix = Number(prefixText);
        if (prefix >= 1 && prefix <= 30) {
          const subnet = normalize(ip, prefix);
          if (subnet) values.add(subnet);
        }
      }
    }
  } catch {}

  return Array.from(values).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
}
