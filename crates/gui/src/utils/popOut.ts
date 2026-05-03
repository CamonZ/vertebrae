import { WebviewWindow } from "@tauri-apps/api/webviewWindow";

export interface PopOutOptions {
  title?: string;
  width?: number;
  height?: number;
  resizable?: boolean;
  focus?: boolean;
}

export interface PopOutResult {
  window: WebviewWindow;
  reused: boolean;
}

/**
 * Open (or focus) a Tauri webview window pointing at an in-app route.
 *
 * Idempotency is keyed off `label`: opening a window whose label already
 * exists focuses the existing one instead of spawning a duplicate. Callers
 * choose the granularity (`task-{taskId}` for one-window-per-entity,
 * `chat-{sessionId}` for one-window-per-session, etc.).
 */
export async function popOut(
  route: string,
  label: string,
  opts: PopOutOptions = {}
): Promise<PopOutResult> {
  const { focus = true, ...windowOpts } = opts;

  const existing = await WebviewWindow.getByLabel(label);
  if (existing) {
    if (focus) {
      await existing.setFocus();
    }
    return { window: existing, reused: true };
  }

  const path = route.startsWith("/") ? route : `/${route}`;

  const webview = new WebviewWindow(label, {
    url: path,
    focus,
    ...windowOpts,
  });

  return { window: webview, reused: false };
}
