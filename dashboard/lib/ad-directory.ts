import { execFile } from "child_process";
import { promisify } from "util";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const execFileAsync = promisify(execFile);

export type AdUser = {
  personnelId: string;
  username: string;
  userPrincipalName: string;
  displayName: string;
  firstName: string;
  lastName: string;
  department: string;
  title: string;
  email: string;
  distinguishedName: string;
};

export type AdComputer = {
  name: string;
  dnsHostName: string;
  operatingSystem: string;
  operatingSystemVersion: string;
  description: string;
  managedBy: string;
  distinguishedName: string;
};

function boolEnv(value: string | undefined, fallback = false) {
  if (value == null) return fallback;
  return ["1", "true", "yes", "on"].includes(value.toLowerCase());
}

export function getAdConfig() {
  const enabled = boolEnv(process.env.AD_ENABLED);
  const url = String(process.env.AD_URL || "").trim();
  const baseDn = String(process.env.AD_BASE_DN || "").trim();
  const personnelAttribute = String(process.env.AD_PERSONNEL_ATTRIBUTE || "sAMAccountName").trim();
  const authMode = String(process.env.AD_AUTH_MODE || (process.env.AD_BIND_USER ? "credentials" : "integrated")).trim().toLowerCase();
  const username = String(process.env.AD_BIND_USER || "").trim();

  let server = "";
  let port = 389;
  let ssl = false;

  try {
    const parsed = new URL(url || "ldap://");
    server = parsed.hostname;
    port = Number(parsed.port || (parsed.protocol === "ldaps:" ? 636 : 389));
    ssl = parsed.protocol === "ldaps:";
  } catch {}

  return {
    enabled,
    url,
    server,
    port,
    ssl,
    baseDn,
    personnelAttribute,
    username,
    authMode,
    hasPassword: Boolean(process.env.AD_BIND_PASSWORD),
    ready: enabled && Boolean(server && baseDn) && (authMode === "integrated" || Boolean(username && process.env.AD_BIND_PASSWORD))
  };
}

async function runPowerShell(operation: "test" | "user" | "computer", value = "") {
  const config = getAdConfig();

  if (process.platform !== "win32") throw new Error("Active Directory integration currently requires a Windows server.");
  if (!config.ready) throw new Error("Active Directory is not fully configured.");

  const script = String.raw`
$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.DirectoryServices

function Escape-Ldap([string]$Value) {
  $sb = New-Object System.Text.StringBuilder
  foreach ($ch in $Value.ToCharArray()) {
    switch ([int][char]$ch) {
      0 { [void]$sb.Append("\00") }
      40 { [void]$sb.Append("\28") }
      41 { [void]$sb.Append("\29") }
      42 { [void]$sb.Append("\2a") }
      92 { [void]$sb.Append("\5c") }
      default { [void]$sb.Append($ch) }
    }
  }
  $sb.ToString()
}

$server = $env:NETWORK_MONITOR_AD_SERVER
$port = [int]$env:NETWORK_MONITOR_AD_PORT
$baseDn = $env:NETWORK_MONITOR_AD_BASE_DN
$bindUser = $env:NETWORK_MONITOR_AD_USER
$bindPassword = $env:NETWORK_MONITOR_AD_PASSWORD
$authMode = $env:NETWORK_MONITOR_AD_AUTH_MODE
$ssl = $env:NETWORK_MONITOR_AD_SSL -eq "1"
$attribute = $env:NETWORK_MONITOR_AD_PERSONNEL_ATTRIBUTE
$value = $env:NETWORK_MONITOR_AD_VALUE
$operation = $env:NETWORK_MONITOR_AD_OPERATION

if ($ssl) {
  $path = "LDAPS://" + $server + ":" + $port + "/" + $baseDn
  $auth = [System.DirectoryServices.AuthenticationTypes]::SecureSocketsLayer
} else {
  $path = "LDAP://" + $server + ":" + $port + "/" + $baseDn
  $auth = [System.DirectoryServices.AuthenticationTypes]::Secure
}

if ($authMode -eq "integrated") {
  $entry = New-Object -TypeName System.DirectoryServices.DirectoryEntry -ArgumentList $path,$null,$null,$auth
} else {
  $entry = New-Object -TypeName System.DirectoryServices.DirectoryEntry -ArgumentList $path,$bindUser,$bindPassword,$auth
}
$searcher = New-Object System.DirectoryServices.DirectorySearcher($entry)
$searcher.PageSize = 1000
$searcher.ClientTimeout = New-TimeSpan -Seconds 8
$searcher.ServerTimeLimit = New-TimeSpan -Seconds 8

if ($operation -eq "test") {
  $searcher.Filter = "(objectClass=*)"
  [void]$searcher.PropertiesToLoad.Add("defaultNamingContext")
  $result = $searcher.FindOne()
  [PSCustomObject]@{ ok = ($null -ne $result); type = "connection" } | ConvertTo-Json -Compress
  exit
}

if ($operation -eq "user") {
  $escaped = Escape-Ldap $value
  $searcher.Filter = "(&(objectCategory=person)(objectClass=user)($attribute=$escaped))"
  foreach ($p in @($attribute,"employeeID","employeeNumber","sAMAccountName","userPrincipalName","displayName","givenName","sn","department","title","mail","distinguishedName")) {
    [void]$searcher.PropertiesToLoad.Add($p)
  }
} elseif ($operation -eq "computer") {
  $escaped = Escape-Ldap $value
  $searcher.Filter = "(&(objectCategory=computer)(|(name=$escaped)(dNSHostName=$escaped)))"
  foreach ($p in @("name","dNSHostName","operatingSystem","operatingSystemVersion","description","managedBy","distinguishedName")) {
    [void]$searcher.PropertiesToLoad.Add($p)
  }
} else {
  throw "Unsupported AD operation."
}

$result = $searcher.FindOne()
if ($null -eq $result) {
  [PSCustomObject]@{ found = $false } | ConvertTo-Json -Compress
  exit
}

function FirstValue($Properties, $Name) {
  if ($Properties.Contains($Name) -and $Properties[$Name].Count -gt 0) { return [string]$Properties[$Name][0] }
  return ""
}

$props = $result.Properties
if ($operation -eq "user") {
  [PSCustomObject]@{
    found = $true
    personnelId = FirstValue $props $attribute
    username = FirstValue $props "sAMAccountName"
    userPrincipalName = FirstValue $props "userPrincipalName"
    displayName = FirstValue $props "displayName"
    firstName = FirstValue $props "givenName"
    lastName = FirstValue $props "sn"
    department = FirstValue $props "department"
    title = FirstValue $props "title"
    email = FirstValue $props "mail"
    distinguishedName = FirstValue $props "distinguishedName"
  } | ConvertTo-Json -Compress
} else {
  [PSCustomObject]@{
    found = $true
    name = FirstValue $props "name"
    dnsHostName = FirstValue $props "dNSHostName"
    operatingSystem = FirstValue $props "operatingSystem"
    operatingSystemVersion = FirstValue $props "operatingSystemVersion"
    description = FirstValue $props "description"
    managedBy = FirstValue $props "managedBy"
    distinguishedName = FirstValue $props "distinguishedName"
  } | ConvertTo-Json -Compress
}
`;

  const env = {
    ...process.env,
    NETWORK_MONITOR_AD_SERVER: config.server,
    NETWORK_MONITOR_AD_PORT: String(config.port),
    NETWORK_MONITOR_AD_BASE_DN: config.baseDn,
    NETWORK_MONITOR_AD_USER: config.username,
    NETWORK_MONITOR_AD_PASSWORD: process.env.AD_BIND_PASSWORD || "",
    NETWORK_MONITOR_AD_AUTH_MODE: config.authMode,
    NETWORK_MONITOR_AD_SSL: config.ssl ? "1" : "0",
    NETWORK_MONITOR_AD_PERSONNEL_ATTRIBUTE: config.personnelAttribute,
    NETWORK_MONITOR_AD_VALUE: value,
    NETWORK_MONITOR_AD_OPERATION: operation
  };

  const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "network-monitor-ad-"));
  const scriptPath = path.join(tempDir, "lookup.ps1");

  try {
    await fs.promises.writeFile(scriptPath, script, "utf8");

    const { stdout } = await execFileAsync("powershell.exe", [
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      scriptPath
    ], { windowsHide: true, timeout: 15000, env });

    const output = String(stdout || "").trim();
    if (!output) throw new Error("Active Directory returned an empty response.");
    return JSON.parse(output);
  } finally {
    await fs.promises.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
}

export async function testAdConnection() { return runPowerShell("test"); }

export async function lookupAdUserByPersonnel(personnelId: string): Promise<AdUser | null> {
  const value = String(personnelId || "").trim();
  if (!value) return null;
  const result = await runPowerShell("user", value);
  if (!result.found) return null;
  return {
    personnelId: String(result.personnelId || value),
    username: String(result.username || ""),
    userPrincipalName: String(result.userPrincipalName || ""),
    displayName: String(result.displayName || ""),
    firstName: String(result.firstName || ""),
    lastName: String(result.lastName || ""),
    department: String(result.department || ""),
    title: String(result.title || ""),
    email: String(result.email || ""),
    distinguishedName: String(result.distinguishedName || "")
  };
}

export async function lookupAdComputer(computerName: string): Promise<AdComputer | null> {
  const value = String(computerName || "").trim().replace(/\.$/, "");
  if (!value) return null;
  const result = await runPowerShell("computer", value);
  if (!result.found) return null;
  return {
    name: String(result.name || ""),
    dnsHostName: String(result.dnsHostName || ""),
    operatingSystem: String(result.operatingSystem || ""),
    operatingSystemVersion: String(result.operatingSystemVersion || ""),
    description: String(result.description || ""),
    managedBy: String(result.managedBy || ""),
    distinguishedName: String(result.distinguishedName || "")
  };
}