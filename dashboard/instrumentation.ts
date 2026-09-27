export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  const intervalSeconds = Math.max(
    60,
    Number(process.env.NETWORK_SCAN_INTERVAL_SECONDS || 300)
  );

  const globalState = globalThis as typeof globalThis & {
    __networkMonitorServerScanStarted?: boolean;
  };

  if (globalState.__networkMonitorServerScanStarted) return;
  globalState.__networkMonitorServerScanStarted = true;

  const runScan = async () => {
    try {
      const { scanServerNetworks } = await import("./lib/server-discovery");
      await scanServerNetworks();
    } catch (error) {
      console.error("server network discovery failed", error);
    } finally {
      setTimeout(runScan, intervalSeconds * 1000);
    }
  };

  setTimeout(runScan, 5000);
}
