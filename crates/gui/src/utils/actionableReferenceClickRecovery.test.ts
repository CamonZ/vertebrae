import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installActionableReferenceClickRecovery } from "./actionableReferenceClickRecovery";

function pointerEvent(
  type: "pointerdown" | "pointerup" | "pointermove",
  x = 20,
  y = 30,
  metaKey = false
): PointerEvent {
  const event = new MouseEvent(type, {
    bubbles: true,
    button: 0,
    buttons: type === "pointerup" ? 0 : 1,
    clientX: x,
    clientY: y,
    metaKey,
  });
  Object.defineProperties(event, {
    isPrimary: { value: true },
    pointerId: { value: 1 },
    pointerType: { value: "mouse" },
  });
  return event as PointerEvent;
}

function fileReferenceButton(): HTMLButtonElement {
  const button = document.createElement("button");
  button.dataset.testid = "local-file-reference-link";
  button.dataset.actionableReference = "file";
  button.dataset.filePath = "src/main.ts";
  document.body.append(button);
  return button;
}

function externalUrlAnchor(): HTMLAnchorElement {
  const anchor = document.createElement("a");
  anchor.dataset.actionableReference = "external-url";
  anchor.dataset.externalUrl = "https://example.com/docs";
  document.body.append(anchor);
  return anchor;
}

describe("actionable reference click recovery", () => {
  let uninstall: (() => void) | null = null;

  beforeEach(() => {
    vi.useFakeTimers();
    uninstall = installActionableReferenceClickRecovery();
  });

  afterEach(() => {
    uninstall?.();
    uninstall = null;
    vi.useRealTimers();
  });

  it("synthesizes a click after a clean pointer press when WebKit omits it", () => {
    const button = fileReferenceButton();
    const onClick = vi.fn();
    button.addEventListener("click", onClick);

    button.dispatchEvent(pointerEvent("pointerdown"));
    button.dispatchEvent(pointerEvent("pointerup"));
    expect(onClick).not.toHaveBeenCalled();

    vi.runAllTimers();

    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("recovers a missing click for an external URL reference", () => {
    const anchor = externalUrlAnchor();
    const onClick = vi.fn((event: MouseEvent) => event.preventDefault());
    anchor.addEventListener("click", onClick);

    anchor.dispatchEvent(pointerEvent("pointerdown"));
    anchor.dispatchEvent(pointerEvent("pointerup"));
    vi.runAllTimers();

    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("cancels recovery when the browser emits the native click", () => {
    const button = fileReferenceButton();
    const onClick = vi.fn();
    button.addEventListener("click", onClick);

    button.dispatchEvent(pointerEvent("pointerdown"));
    button.dispatchEvent(pointerEvent("pointerup"));
    button.click();
    vi.runAllTimers();

    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("does not recover a gesture that moved beyond the click threshold", () => {
    const button = fileReferenceButton();
    const onClick = vi.fn();
    button.addEventListener("click", onClick);

    button.dispatchEvent(pointerEvent("pointerdown"));
    button.dispatchEvent(pointerEvent("pointermove", 40, 50));
    button.dispatchEvent(pointerEvent("pointerup"));
    vi.runAllTimers();

    expect(onClick).not.toHaveBeenCalled();
  });

  it("does not recover when a modifier is pressed before pointer-up", () => {
    const button = fileReferenceButton();
    const onClick = vi.fn();
    button.addEventListener("click", onClick);

    button.dispatchEvent(pointerEvent("pointerdown"));
    button.dispatchEvent(pointerEvent("pointerup", 20, 30, true));
    vi.runAllTimers();

    expect(onClick).not.toHaveBeenCalled();
  });
});
