function isTrue(value: string | undefined) {
  return ["1", "true", "yes", "on"].includes(String(value || "").toLowerCase());
}

export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  if (process.env.NEXT_PHASE === "phase-production-build") return;

  const intervalSeconds = Math.max(
    60,
    Number(process.env.NETWORK_SCAN_INTERVAL_SECONDS || 900)
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

  // همگام‌سازی دوره‌ای کاربران (و در صورت تمایل کامپیوترهای) Active Directory.
  // heartbeat ایجنت‌ها نام و شماره پرسنلی را از همین داده‌ها پیدا می‌کند.
  if (isTrue(process.env.AD_ENABLED)) {
    const adIntervalMs =
      Math.max(10, Number(process.env.AD_SYNC_INTERVAL_MINUTES || 60)) * 60 * 1000;
    const actions = ["sync-users", ...(isTrue(process.env.AD_SYNC_COMPUTERS) ? ["sync-computers"] : [])];

    const triggerAdSync = async () => {
      try {
        for (const action of actions) {
          const response = await fetch(`http://127.0.0.1:${port}/api/directory`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ action }),
            cache: "no-store"
          });
          if (!response.ok) console.error(`AD ${action} failed with HTTP ${response.status}`);
        }
      } catch (error) {
        console.error("AD sync trigger failed", error);
      } finally {
        setTimeout(triggerAdSync, adIntervalMs);
      }
    };

    setTimeout(triggerAdSync, 15000);
  }
}
