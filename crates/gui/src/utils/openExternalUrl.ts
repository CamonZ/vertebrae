import { openUrl } from "@tauri-apps/plugin-opener";

export function isAbsoluteHttpUrl(
  href: string | null | undefined
): href is string {
  if (!href || !/^https?:\/\//i.test(href)) return false;
  try {
    const url = new URL(href);
    return (
      (url.protocol === "http:" || url.protocol === "https:") &&
      url.hostname.length > 0
    );
  } catch {
    return false;
  }
}

export function openExternalUrl(href: string): void {
  if (!isAbsoluteHttpUrl(href)) {
    console.error("Refused to open non-http(s) URL:", href);
    return;
  }
  void openUrl(href).catch((error: unknown) => {
    console.error("Could not open external URL:", error);
  });
}
