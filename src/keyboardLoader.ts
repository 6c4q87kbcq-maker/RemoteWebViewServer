import { KeyboardScriptConfig } from "./config.js";

let cachedUrl: string | undefined;
let cachedScript: string | undefined;

function isAllowedProtocol(url: URL, allowHttp: boolean): boolean {
  if (url.protocol === "https:") return true;
  if (allowHttp && url.protocol === "http:") return true;
  return false;
}

export async function getKeyboardScriptFromDirectUrl(cfg: KeyboardScriptConfig): Promise<string | undefined> {
  if (!cfg.url) {
    console.warn("[keyboard] KEYBOARD_SCRIPT_URL is not set; keyboard injection skipped");
    return undefined;
  }

  if (cachedUrl === cfg.url && cachedScript) {
    return cachedScript;
  }

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(cfg.url);
  } catch {
    console.warn("[keyboard] Invalid KEYBOARD_SCRIPT_URL; keyboard injection skipped");
    return undefined;
  }

  if (!isAllowedProtocol(parsedUrl, cfg.allowHttp)) {
    console.warn("[keyboard] KEYBOARD_SCRIPT_URL must use https (or http when KEYBOARD_SCRIPT_ALLOW_HTTP=true)");
    return undefined;
  }

  if (typeof fetch !== "function") {
    console.warn("[keyboard] fetch is not available in this Node runtime; keyboard injection skipped");
    return undefined;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);

  try {
    const response = await fetch(parsedUrl, {
      method: "GET",
      redirect: "follow",
      signal: controller.signal,
      headers: {
        "Accept": "application/javascript, text/javascript, text/plain;q=0.9, */*;q=0.8",
      },
    });

    if (!response.ok) {
      console.warn(`[keyboard] Failed to download script: HTTP ${response.status}; keyboard injection skipped`);
      return undefined;
    }

    const bytes = Buffer.from(await response.arrayBuffer());
    const script = bytes.toString("utf8");
    if (!script.trim()) {
      console.warn("[keyboard] Downloaded script is empty; keyboard injection skipped");
      return undefined;
    }

    cachedUrl = cfg.url;
    cachedScript = script;
    return script;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`[keyboard] Failed to download script: ${message}; keyboard injection skipped`);
    return undefined;
  } finally {
    clearTimeout(timeout);
  }
}
