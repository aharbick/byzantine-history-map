#!/usr/bin/env node
/**
 * Capture a screenshot of the running dev server at OG-card dimensions
 * (1200x630) and write it to web/src/app/opengraph-image.png. Next.js's
 * file-system metadata convention picks the file up automatically and
 * emits the og:image / twitter:image meta tags at build time.
 *
 * Usage:
 *   1. Start the dev server (`cd web && npm run dev`).
 *   2. Run this script (`node web/tools/capture-og-image.mjs`).
 *
 * Talks to a headless Chrome over CDP rather than relying on
 * `chrome --screenshot`, because the latter snapshots immediately on
 * `load` — long before MapLibre fetches its tiles or the marker layer
 * renders. Here we navigate, wait for the markers and tile container
 * to materialize, then grab a frame.
 */
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const URL_TO_CAPTURE = "http://localhost:3000/?notour=1";
const OUT_PATH = new URL("../src/app/opengraph-image.png", import.meta.url)
  .pathname;
const WIDTH = 1200;
const HEIGHT = 630;
// Real-time budget for MapLibre tiles + marker render. Excessive but
// the script is hand-run; better to overshoot than capture a half-painted
// frame.
const SETTLE_MS = 8000;

async function getCdpEndpoint(port) {
  // Chrome exposes a JSON listing on /json/version once the debugger is
  // ready. Poll briefly while it spins up.
  for (let i = 0; i < 40; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (res.ok) return await res.json();
    } catch {
      /* not ready yet */
    }
    await sleep(100);
  }
  throw new Error("Chrome debugger never came up");
}

async function getFirstPageTarget(port) {
  const res = await fetch(`http://127.0.0.1:${port}/json/list`);
  const targets = await res.json();
  const page = targets.find((t) => t.type === "page");
  if (!page) throw new Error("No page target found");
  return page;
}

function openWs(url) {
  return new Promise((resolve, reject) => {
    const handlers = new Map();
    const pending = new Map();
    let nextId = 1;
    // Use the WebSocket polyfill that ships with Node 22.
    const ws = new WebSocket(url);
    ws.addEventListener("open", () => resolve(api));
    ws.addEventListener("error", (e) => reject(e));
    ws.addEventListener("message", (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id != null && pending.has(msg.id)) {
        const { resolve: r, reject: j } = pending.get(msg.id);
        pending.delete(msg.id);
        if (msg.error) j(new Error(msg.error.message));
        else r(msg.result);
      } else if (msg.method && handlers.has(msg.method)) {
        handlers.get(msg.method)(msg.params);
      }
    });
    const api = {
      send(method, params = {}) {
        const id = nextId++;
        return new Promise((resolve, reject) => {
          pending.set(id, { resolve, reject });
          ws.send(JSON.stringify({ id, method, params }));
        });
      },
      on(method, fn) {
        handlers.set(method, fn);
      },
      close() {
        ws.close();
      },
    };
  });
}

async function main() {
  const userDataDir = await mkdtemp(join(tmpdir(), "chrome-og-"));
  const port = 9222 + Math.floor(Math.random() * 1000);
  const chrome = spawn(
    CHROME,
    [
      "--headless=new",
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${userDataDir}`,
      "--hide-scrollbars",
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-features=Translate",
      `--window-size=${WIDTH},${HEIGHT}`,
      "about:blank",
    ],
    { stdio: ["ignore", "ignore", "pipe"] },
  );
  let chromeErr = "";
  chrome.stderr.on("data", (d) => (chromeErr += d.toString()));

  try {
    await getCdpEndpoint(port);
    const target = await getFirstPageTarget(port);
    const cdp = await openWs(target.webSocketDebuggerUrl);

    await cdp.send("Page.enable");
    // Lock the layout viewport so the screenshot matches OG dimensions
    // even though headless Chrome's window includes scrollbar gutters.
    await cdp.send("Emulation.setDeviceMetricsOverride", {
      width: WIDTH,
      height: HEIGHT,
      deviceScaleFactor: 1,
      mobile: false,
    });

    await cdp.send("Page.navigate", { url: URL_TO_CAPTURE });
    // Wait for the load event...
    await new Promise((resolve) => cdp.on("Page.loadEventFired", resolve));
    // ...then for the map to settle.
    await sleep(SETTLE_MS);

    const { data } = await cdp.send("Page.captureScreenshot", {
      format: "png",
      captureBeyondViewport: false,
    });
    await writeFile(OUT_PATH, Buffer.from(data, "base64"));
    console.log(`Wrote ${OUT_PATH}`);

    cdp.close();
  } finally {
    chrome.kill("SIGTERM");
    await sleep(200);
    if (!chrome.killed) chrome.kill("SIGKILL");
    await rm(userDataDir, { recursive: true, force: true }).catch(() => {});
    if (chromeErr && process.env.DEBUG_OG) {
      process.stderr.write(`[chrome stderr] ${chromeErr}\n`);
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
