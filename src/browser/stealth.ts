import { BrowserContext } from "playwright";

/**
 * Injects anti-detection patches into every page before any site JS runs.
 * Targets: Akamai Bot Manager, PerimeterX, DataDome, Cloudflare Turnstile.
 */
export async function applyStealthPatches(context: BrowserContext): Promise<void> {
  await context.addInitScript(() => {
    // 1. Remove the automation flag entirely.
    Object.defineProperty(navigator, "webdriver", {
      get: () => false,
    });

    // 2. Ensure window.chrome looks like a real Chrome install.
    const win = window as any;
    if (!win.chrome) {
      Object.defineProperty(window, "chrome", {
        value: {},
        writable: true,
        configurable: true,
      });
    }
    const chrome = win.chrome;
    if (!chrome.runtime) {
      chrome.runtime = {
        PlatformOs: { MAC: "mac", WIN: "win", ANDROID: "android", CROS: "cros", LINUX: "linux" },
        PlatformArch: { ARM: "arm", X86_32: "x86-32", X86_64: "x86-64" },
        PlatformNaclArch: { ARM: "arm", X86_32: "x86-32", X86_64: "x86-64" },
        RequestUpdateCheckStatus: { THROTTLED: "throttled", NO_UPDATE: "no_update", UPDATE_AVAILABLE: "update_available" },
        OnInstalledReason: { INSTALL: "install", UPDATE: "update" },
        OnRestartRequiredReason: { APP_UPDATE: "app_update", OS_UPDATE: "os_update", PERIODIC: "periodic" },
        connect: () => {},
        sendMessage: () => {},
        id: undefined,
      };
    }
    if (!chrome.csi) chrome.csi = () => ({});
    if (!chrome.loadTimes) {
      chrome.loadTimes = () => ({
        requestTime: Date.now() / 1000,
        startLoadTime: Date.now() / 1000,
        commitLoadTime: Date.now() / 1000,
        finishDocumentLoadTime: Date.now() / 1000,
        finishLoadTime: Date.now() / 1000,
        firstPaintTime: Date.now() / 1000,
        firstPaintAfterLoadTime: 0,
        navigationType: "Other",
        wasFetchedViaSpdy: false,
        wasNpnNegotiated: true,
        npnNegotiatedProtocol: "h2",
        wasAlternateProtocolAvailable: false,
        connectionInfo: "h2",
      });
    }

    // 3. Languages — match a real browser.
    Object.defineProperty(navigator, "languages", {
      get: () => ["en-US", "en"],
    });

    // 4. Plugins — real Chrome always has PDF plugins.
    Object.defineProperty(navigator, "plugins", {
      get: () => {
        const arr = [
          { name: "PDF Viewer", filename: "internal-pdf-viewer", description: "Portable Document Format" },
          { name: "Chrome PDF Viewer", filename: "internal-pdf-viewer", description: "" },
          { name: "Chromium PDF Viewer", filename: "internal-pdf-viewer", description: "" },
          { name: "Microsoft Edge PDF Viewer", filename: "internal-pdf-viewer", description: "" },
          { name: "WebKit built-in PDF", filename: "internal-pdf-viewer", description: "" },
        ];
        Object.setPrototypeOf(arr, PluginArray.prototype);
        return arr;
      },
    });

    // 5. Permissions API — prevent notification leak.
    const origQuery = navigator.permissions?.query?.bind(navigator.permissions);
    if (origQuery) {
      navigator.permissions.query = ((params: PermissionDescriptor) => {
        if (params.name === "notifications") {
          return Promise.resolve({ state: Notification.permission } as PermissionStatus);
        }
        return origQuery(params);
      }) as typeof navigator.permissions.query;
    }

    // 6. Hide automation-related properties that some detectors check.
    delete (window as any).__playwright;
    delete (window as any).__pw_manual;

    // 7. Prevent iframe-based detection of different contexts.
    const origToString = Function.prototype.toString;
    const nativeStr = "function toString() { [native code] }";
    Function.prototype.toString = function () {
      if (this === Function.prototype.toString) return nativeStr;
      return origToString.call(this);
    };
  });
}
