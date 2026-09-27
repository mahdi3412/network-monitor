export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  const intervalSeconds = Math.max(
    60,
    Number(process.env.NETWORK_SCAN_INTERVAL_SECONDS || 300)
  );

  const state = globalThis as typeof globalThis & {
    __networkMonitorServerScanStarted?: boolean;
  };

  if (state.__networkMonitorServerScanStarted) return;
  state.__networkMonitorServerScanStarted = true;

  const port = Number(process.env.PORT || 3000);
  const triggerScan = async () => {
    try {
      await fetch(`http://127.0.0.1:${port}/api/network-scan`, {
        method: "POST",
        cache: "no-store"
      });
    } catch (error) {
      console.error("server network discovery trigger failed", error);
    } finally {
      setTimeout(triggerScan, intervalSeconds * 1000);
    }
  };

  setTimeout(triggerScan, 5000);
}
