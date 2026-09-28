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
  const rawUrls = String(process.env.AD_URLS || process.env.AD_URL || "").trim();
  const urls = rawUrls
    .split(/[,;\s]+/)
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => /^[a-z]+:\/\//i.test(item) ? item : `ldap://${item}`);
  const baseDn = String(process.env.AD_BASE_DN || "").trim();
  const personnelAttribute = String(process.env.AD_PERSONNEL_ATTRIBUTE || "sAMAccountName").trim();
  const authMode = String(process.env.AD_AUTH_MODE || (process.env.AD_BIND_USER ? "credentials" : "integrated")).trim().toLowerCase();
  const username = String(process.env.AD_BIND_USER || "").trim();
  let server = "";
  let port = 389;
  let ssl = false;
  try {
    const parsed = new URL(urls[0] || "ldap://");
    server = parsed.hostname;
    port = Number(parsed.port || (parsed.protocol === "ldaps:" ? 636 : 389));
    ssl = parsed.protocol === "ldaps:";
  } catch {}
  return {
    enabled, url: urls[0] || "", urls, server, port, ssl, baseDn, personnelAttribute, username, authMode,
    hasPassword: Boolean(process.env.AD_BIND_PASSWORD),
    ready: enabled && urls.length > 0 && Boolean(baseDn) && (authMode === "integrated" || Boolean(username && process.env.AD_BIND_PASSWORD))
  };
}
async function runPowerShell(operation: "test" | "user" | "computer", value = "") {
  const config = getAdConfig();

  if (process.platform !== "win32") throw new Error("Active Directory integration currently requires a Windows server.");
  if (!config.ready) throw new Error("Active Directory is not fully configured.");

  const script = String.raw`
$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.DirectoryServices.Protocols

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

function First-AttributeValue($Entry, [string]$Name) {
  if ($null -ne $Entry.Attributes -and $Entry.Attributes.Contains($Name) -and $Entry.Attributes[$Name].Count -gt 0) {
    return [string]$Entry.Attributes[$Name][0]
  }
  return ""
}

$serversRaw = $env:NETWORK_MONITOR_AD_SERVERS
$baseDn = $env:NETWORK_MONITOR_AD_BASE_DN
$bindUser = $env:NETWORK_MONITOR_AD_USER
$bindPassword = $env:NETWORK_MONITOR_AD_PASSWORD
$authMode = $env:NETWORK_MONITOR_AD_AUTH_MODE
$ssl = $env:NETWORK_MONITOR_AD_SSL -eq "1"
$attribute = $env:NETWORK_MONITOR_AD_PERSONNEL_ATTRIBUTE
$value = $env:NETWORK_MONITOR_AD_VALUE
$operation = $env:NETWORK_MONITOR_AD_OPERATION

$servers = @($serversRaw -split "\|" | Where-Object { $_ -and $_.Trim() })

foreach ($serverUrl in $servers) {
  $connection = $null
  try {
    $uri = [Uri]$serverUrl
    $server = $uri.Host
    $port = if ($uri.Port -gt 0) { $uri.Port } elseif ($uri.Scheme -eq "ldaps") { 636 } else { 389 }
    $useSsl = $uri.Scheme -eq "ldaps" -or $ssl

    $identifier = New-Object System.DirectoryServices.Protocols.LdapDirectoryIdentifier($server,$port,$true,$false)

    if ($authMode -eq "integrated") {
      $connection = New-Object System.DirectoryServices.Protocols.LdapConnection($identifier)
      $connection.AuthType = [System.DirectoryServices.Protocols.AuthType]::Negotiate
    } else {
      $credential = New-Object System.Net.NetworkCredential($bindUser,$bindPassword)
      $connection = New-Object System.DirectoryServices.Protocols.LdapConnection($identifier,$credential,[System.DirectoryServices.Protocols.AuthType]::Negotiate)
    }

    $connection.SessionOptions.ProtocolVersion = 3
    if ($useSsl) { $connection.SessionOptions.SecureSocketLayer = $true }
    $connection.Bind()

    if ($operation -eq "test") {
      $request = New-Object System.DirectoryServices.Protocols.SearchRequest($baseDn,"(objectClass=*)",[System.DirectoryServices.Protocols.SearchScope]::Base,"defaultNamingContext")
      $response = $connection.SendRequest($request)
      if ($response.Entries.Count -gt 0) {
        [PSCustomObject]@{ ok = $true; type = "connection"; server = $server; port = $port; ssl = $useSsl; auth = "Negotiate" } | ConvertTo-Json -Compress
        exit
      }
      throw "LDAP bind succeeded but the base DN returned no entries."
    }

    if ($operation -eq "user") {
      $escaped = Escape-Ldap $value
      $filter = "(&(objectCategory=person)(objectClass=user)($attribute=$escaped))"
      $properties = @($attribute,"employeeID","employeeNumber","sAMAccountName","userPrincipalName","displayName","givenName","sn","department","title","mail","distinguishedName")
    } elseif ($operation -eq "computer") {
      $escaped = Escape-Ldap $value
      $filter = "(&(objectCategory=computer)(|(name=$escaped)(dNSHostName=$escaped)))"
      $properties = @("name","dNSHostName","operatingSystem","operatingSystemVersion","description","managedBy","distinguishedName")
    } else {
      throw "Unsupported AD operation."
    }

    $request = New-Object System.DirectoryServices.Protocols.SearchRequest($baseDn,$filter,[System.DirectoryServices.Protocols.SearchScope]::Subtree,(,$properties))
    $request.SizeLimit = 1
    $response = $connection.SendRequest($request)

    if ($response.Entries.Count -eq 0) {
      [PSCustomObject]@{ found = $false; server = $server; port = $port; ssl = $useSsl } | ConvertTo-Json -Compress
      exit
    }

    $entry = $response.Entries[0]

    if ($operation -eq "user") {
      [PSCustomObject]@{
        found = $true
        server = $server
        port = $port
        ssl = $useSsl
        personnelId = First-AttributeValue $entry $attribute
        username = First-AttributeValue $entry "sAMAccountName"
        userPrincipalName = First-AttributeValue $entry "userPrincipalName"
        displayName = First-AttributeValue $entry "displayName"
        firstName = First-AttributeValue $entry "givenName"
        lastName = First-AttributeValue $entry "sn"
        department = First-AttributeValue $entry "department"
        title = First-AttributeValue $entry "title"
        email = First-AttributeValue $entry "mail"
        distinguishedName = First-AttributeValue $entry "distinguishedName"
      } | ConvertTo-Json -Compress
    } else {
      [PSCustomObject]@{
        found = $true
        server = $server
        port = $port
        ssl = $useSsl
        name = First-AttributeValue $entry "name"
        dnsHostName = First-AttributeValue $entry "dNSHostName"
        operatingSystem = First-AttributeValue $entry "operatingSystem"
        operatingSystemVersion = First-AttributeValue $entry "operatingSystemVersion"
        description = First-AttributeValue $entry "description"
        managedBy = First-AttributeValue $entry "managedBy"
        distinguishedName = First-AttributeValue $entry "distinguishedName"
      } | ConvertTo-Json -Compress
    }
    exit
  } catch {
    $detail = $_.Exception
    $ldap = $_.Exception.InnerException
    [Console]::Error.WriteLine(("server={0};type={1};message={2};errorCode={3};serverErrorMessage={4}" -f $serverUrl,$detail.GetType().FullName,$detail.Message,
      $(if ($detail.PSObject.Properties["ErrorCode"]) { $detail.ErrorCode } elseif ($ldap -and $ldap.PSObject.Properties["ErrorCode"]) { $ldap.ErrorCode } else { "" }),
      $(if ($detail.PSObject.Properties["ServerErrorMessage"]) { $detail.ServerErrorMessage } elseif ($ldap -and $ldap.PSObject.Properties["ServerErrorMessage"]) { $ldap.ServerErrorMessage } else { "" })
    ))
  } finally {
    if ($null -ne $connection) { $connection.Dispose() }
  }
}

throw "All configured Active Directory servers failed. Check the server-side error details above."
`;

  const env = {
    ...process.env,
    NETWORK_MONITOR_AD_SERVERS: config.urls.join("|"),
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
    try {
      const { stdout, stderr } = await execFileAsync("powershell.exe", ["-NoProfile","-NonInteractive","-ExecutionPolicy","Bypass","-File",scriptPath], { windowsHide: true, timeout: 30000, env });
      const output = String(stdout || "").trim();
      if (!output) {
        const detail = String(stderr || "").trim();
        throw new Error(detail || "Active Directory returned an empty response.");
      }
      return JSON.parse(output);
    } catch (error: any) {
      const stderr = String(error?.stderr || "").trim();
      const message = String(error?.message || error);
      throw new Error(stderr ? message + "\n" + stderr : message);
    }
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
export async function syncAdUsers() {
  const config = getAdConfig();

  if (process.platform !== "win32") throw new Error("Active Directory integration currently requires a Windows server.");
  if (!config.ready) throw new Error("Active Directory is not fully configured.");

  const script = String.raw`
$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.DirectoryServices.Protocols

function First-AttributeValue($Entry, [string]$Name) {
  if ($null -ne $Entry.Attributes -and $Entry.Attributes.Contains($Name) -and $Entry.Attributes[$Name].Count -gt 0) {
    return [string]$Entry.Attributes[$Name][0]
  }
  return ""
}

$serversRaw = $env:NETWORK_MONITOR_AD_SERVERS
$baseDn = $env:NETWORK_MONITOR_AD_BASE_DN
$bindUser = $env:NETWORK_MONITOR_AD_USER
$bindPassword = $env:NETWORK_MONITOR_AD_PASSWORD
$authMode = $env:NETWORK_MONITOR_AD_AUTH_MODE
$ssl = $env:NETWORK_MONITOR_AD_SSL -eq "1"
$servers = @($serversRaw -split "\|" | Where-Object { $_ -and $_.Trim() })
$properties = @("sAMAccountName","userPrincipalName","displayName","givenName","sn","department","title","mail","distinguishedName","employeeID","employeeNumber")

foreach ($serverUrl in $servers) {
  $connection = $null
  try {
    $uri = [Uri]$serverUrl
    $server = $uri.Host
    $port = if ($uri.Port -gt 0) { $uri.Port } elseif ($uri.Scheme -eq "ldaps") { 636 } else { 389 }
    $useSsl = $uri.Scheme -eq "ldaps" -or $ssl
    $identifier = New-Object System.DirectoryServices.Protocols.LdapDirectoryIdentifier($server,$port,$true,$false)

    if ($authMode -eq "integrated") {
      $connection = New-Object System.DirectoryServices.Protocols.LdapConnection($identifier)
      $connection.AuthType = [System.DirectoryServices.Protocols.AuthType]::Negotiate
    } else {
      $credential = New-Object System.Net.NetworkCredential($bindUser,$bindPassword)
      $connection = New-Object System.DirectoryServices.Protocols.LdapConnection($identifier,$credential,[System.DirectoryServices.Protocols.AuthType]::Negotiate)
    }

    $connection.SessionOptions.ProtocolVersion = 3
    if ($useSsl) { $connection.SessionOptions.SecureSocketLayer = $true }
    $connection.Bind()

    $filter = "(&(objectCategory=person)(objectClass=user)(sAMAccountName=*))"
    $cookie = New-Object byte[] 0
    $users = New-Object System.Collections.Generic.List[object]

    do {
      $request = New-Object System.DirectoryServices.Protocols.SearchRequest($baseDn,$filter,[System.DirectoryServices.Protocols.SearchScope]::Subtree,(,$properties))
      $request.SizeLimit = 1000
      $page = New-Object System.DirectoryServices.Protocols.PageResultRequestControl(500)
      if ($cookie.Length -gt 0) { $page.Cookie = $cookie }
      [void]$request.Controls.Add($page)
      $response = $connection.SendRequest($request)

      foreach ($entry in $response.Entries) {
        $username = First-AttributeValue $entry "sAMAccountName"
        if (-not $username) { continue }
        $users.Add([PSCustomObject]@{
          personnelId = $(First-AttributeValue $entry "employeeID");
          employeeNumber = $(First-AttributeValue $entry "employeeNumber");
          username = $username;
          userPrincipalName = $(First-AttributeValue $entry "userPrincipalName");
          displayName = $(First-AttributeValue $entry "displayName");
          firstName = $(First-AttributeValue $entry "givenName");
          lastName = $(First-AttributeValue $entry "sn");
          department = $(First-AttributeValue $entry "department");
          title = $(First-AttributeValue $entry "title");
          email = $(First-AttributeValue $entry "mail");
          distinguishedName = $(First-AttributeValue $entry "distinguishedName")
        })
      }

      $pageResponse = $response.Controls | Where-Object { $_ -is [System.DirectoryServices.Protocols.PageResultResponseControl] } | Select-Object -First 1
      $cookie = if ($pageResponse) { $pageResponse.Cookie } else { New-Object byte[] 0 }
    } while ($cookie.Length -gt 0)

    [PSCustomObject]@{ ok = $true; server = $server; port = $port; ssl = $useSsl; users = @($users) } | ConvertTo-Json -Compress -Depth 6
    exit
  } catch {
    $detail = $_.Exception
    $ldap = $_.Exception.InnerException
    [Console]::Error.WriteLine(("server={0};type={1};message={2};errorCode={3};serverErrorMessage={4}" -f $serverUrl,$detail.GetType().FullName,$detail.Message,
      $(if ($detail.PSObject.Properties["ErrorCode"]) { $detail.ErrorCode } elseif ($ldap -and $ldap.PSObject.Properties["ErrorCode"]) { $ldap.ErrorCode } else { "" }),
      $(if ($detail.PSObject.Properties["ServerErrorMessage"]) { $detail.ServerErrorMessage } elseif ($ldap -and $ldap.PSObject.Properties["ServerErrorMessage"]) { $ldap.ServerErrorMessage } else { "" })
    ))
  } finally {
    if ($null -ne $connection) { $connection.Dispose() }
  }
}

throw "All configured Active Directory servers failed."
`;

  const env = {
    ...process.env,
    NETWORK_MONITOR_AD_SERVERS: config.urls.join("|"),
    NETWORK_MONITOR_AD_BASE_DN: config.baseDn,
    NETWORK_MONITOR_AD_USER: config.username,
    NETWORK_MONITOR_AD_PASSWORD: process.env.AD_BIND_PASSWORD || "",
    NETWORK_MONITOR_AD_AUTH_MODE: config.authMode,
    NETWORK_MONITOR_AD_SSL: config.ssl ? "1" : "0"
  };

  const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "network-monitor-ad-sync-"));
  const scriptPath = path.join(tempDir, "sync-users.ps1");

  try {
    await fs.promises.writeFile(scriptPath, script, "utf8");
    try {
      const { stdout, stderr } = await execFileAsync("powershell.exe", ["-NoProfile","-NonInteractive","-ExecutionPolicy","Bypass","-File",scriptPath], { windowsHide: true, timeout: 120000, env });
      const output = String(stdout || "").trim();
      if (!output) {
        const detail = String(stderr || "").trim();
        throw new Error(detail || "Active Directory returned an empty response.");
      }
      const parsed = JSON.parse(output);
      return Array.isArray(parsed?.users) ? parsed.users : [];
    } catch (error: any) {
      const stderr = String(error?.stderr || "").trim();
      const message = String(error?.message || error);
      throw new Error(stderr ? message + "\n" + stderr : message);
    }
  } finally {
    await fs.promises.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
}
export async function syncAdComputers() {
  const config = getAdConfig();
  if (process.platform !== "win32") throw new Error("Active Directory integration currently requires a Windows server.");
  if (!config.ready) throw new Error("Active Directory is not fully configured.");

  const script = String.raw`
$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.DirectoryServices.Protocols

function First-AttributeValue($Entry, [string]$Name) {
  if ($null -ne $Entry.Attributes -and $Entry.Attributes.Contains($Name) -and $Entry.Attributes[$Name].Count -gt 0) { return [string]$Entry.Attributes[$Name][0] }
  return ""
}

$servers = @($env:NETWORK_MONITOR_AD_SERVERS -split "\|" | Where-Object { $_ -and $_.Trim() })
$baseDn = $env:NETWORK_MONITOR_AD_BASE_DN
$bindUser = $env:NETWORK_MONITOR_AD_USER
$bindPassword = $env:NETWORK_MONITOR_AD_PASSWORD
$authMode = $env:NETWORK_MONITOR_AD_AUTH_MODE
$ssl = $env:NETWORK_MONITOR_AD_SSL -eq "1"
$properties = @("name","dNSHostName","operatingSystem","operatingSystemVersion","description","managedBy","distinguishedName")

foreach ($serverUrl in $servers) {
  $connection = $null
  try {
    $uri = [Uri]$serverUrl
    $server = $uri.Host
    $port = if ($uri.Port -gt 0) { $uri.Port } elseif ($uri.Scheme -eq "ldaps") { 636 } else { 389 }
    $useSsl = $uri.Scheme -eq "ldaps" -or $ssl
    $identifier = New-Object System.DirectoryServices.Protocols.LdapDirectoryIdentifier($server,$port,$true,$false)

    if ($authMode -eq "integrated") {
      $connection = New-Object System.DirectoryServices.Protocols.LdapConnection($identifier)
      $connection.AuthType = [System.DirectoryServices.Protocols.AuthType]::Negotiate
    } else {
      $credential = New-Object System.Net.NetworkCredential($bindUser,$bindPassword)
      $connection = New-Object System.DirectoryServices.Protocols.LdapConnection($identifier,$credential,[System.DirectoryServices.Protocols.AuthType]::Negotiate)
    }
    $connection.SessionOptions.ProtocolVersion = 3
    if ($useSsl) { $connection.SessionOptions.SecureSocketLayer = $true }
    $connection.Bind()

    $filter = "(&(objectCategory=computer)(objectClass=computer)(dNSHostName=*))"
    $cookie = New-Object byte[] 0
    $computers = New-Object System.Collections.Generic.List[object]

    do {
      $request = New-Object System.DirectoryServices.Protocols.SearchRequest($baseDn,$filter,[System.DirectoryServices.Protocols.SearchScope]::Subtree,(,$properties))
      $request.SizeLimit = 1000
      $page = New-Object System.DirectoryServices.Protocols.PageResultRequestControl(500)
      if ($cookie.Length -gt 0) { $page.Cookie = $cookie }
      [void]$request.Controls.Add($page)
      $response = $connection.SendRequest($request)

      foreach ($entry in $response.Entries) {
        $name = First-AttributeValue $entry "name"
        $dns = First-AttributeValue $entry "dNSHostName"
        if (-not $name -and -not $dns) { continue }
        $computers.Add([PSCustomObject]@{
          name = $name;
          dnsHostName = $dns;
          operatingSystem = First-AttributeValue $entry "operatingSystem";
          operatingSystemVersion = First-AttributeValue $entry "operatingSystemVersion";
          description = First-AttributeValue $entry "description";
          managedBy = First-AttributeValue $entry "managedBy";
          distinguishedName = First-AttributeValue $entry "distinguishedName"
        })
      }
      $pageResponse = $response.Controls | Where-Object { $_ -is [System.DirectoryServices.Protocols.PageResultResponseControl] } | Select-Object -First 1
      $cookie = if ($pageResponse) { $pageResponse.Cookie } else { New-Object byte[] 0 }
    } while ($cookie.Length -gt 0)

    [PSCustomObject]@{ ok = $true; server = $server; port = $port; ssl = $useSsl; computers = @($computers) } | ConvertTo-Json -Compress -Depth 6
    exit
  } catch {
    $detail = $_.Exception; $ldap = $_.Exception.InnerException
    [Console]::Error.WriteLine(("server={0};type={1};message={2};errorCode={3};serverErrorMessage={4}" -f $serverUrl,$detail.GetType().FullName,$detail.Message,
      $(if ($detail.PSObject.Properties["ErrorCode"]) { $detail.ErrorCode } elseif ($ldap -and $ldap.PSObject.Properties["ErrorCode"]) { $ldap.ErrorCode } else { "" }),
      $(if ($detail.PSObject.Properties["ServerErrorMessage"]) { $detail.ServerErrorMessage } elseif ($ldap -and $ldap.PSObject.Properties["ServerErrorMessage"]) { $ldap.ServerErrorMessage } else { "" })
    ))
  } finally { if ($null -ne $connection) { $connection.Dispose() } }
}

throw "All configured Active Directory servers failed."
`;

  const env = {
    ...process.env,
    NETWORK_MONITOR_AD_SERVERS: config.urls.join("|"),
    NETWORK_MONITOR_AD_BASE_DN: config.baseDn,
    NETWORK_MONITOR_AD_USER: config.username,
    NETWORK_MONITOR_AD_PASSWORD: process.env.AD_BIND_PASSWORD || "",
    NETWORK_MONITOR_AD_AUTH_MODE: config.authMode,
    NETWORK_MONITOR_AD_SSL: config.ssl ? "1" : "0"
  };

  const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "network-monitor-ad-computers-"));
  const scriptPath = path.join(tempDir, "sync-computers.ps1");
  try {
    await fs.promises.writeFile(scriptPath, script, "utf8");
    const { stdout, stderr } = await execFileAsync("powershell.exe", ["-NoProfile","-NonInteractive","-ExecutionPolicy","Bypass","-File",scriptPath], { windowsHide: true, timeout: 120000, env });
    const output = String(stdout || "").trim();
    if (!output) throw new Error(String(stderr || "").trim() || "Active Directory returned an empty response.");
    const parsed = JSON.parse(output);
    return Array.isArray(parsed?.computers) ? parsed.computers : [];
  } catch (error: any) {
    const stderr = String(error?.stderr || "").trim();
    const message = String(error?.message || error);
    throw new Error(stderr ? message + "\n" + stderr : message);
  } finally {
    await fs.promises.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
}