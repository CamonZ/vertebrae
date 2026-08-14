import { addDebugLog } from "./debugLog";

const ACTIONABLE_REFERENCE_SELECTOR = [
  '[data-testid="local-file-reference-link"]',
  '[data-testid="vtb-entity-link"]',
].join(",");

const EVENT_TYPES = [
  "pointerdown",
  "mousedown",
  "pointerup",
  "pointercancel",
  "mouseup",
  "dragstart",
  "click",
] as const;

let clickSequence = 0;
let elementSequence = 0;
const elementIds = new WeakMap<Element, number>();

interface ActiveGesture {
  pointerId: number;
  downTarget: EventTarget | null;
  downReference: Element;
  startX: number;
  startY: number;
  maxMovement: number;
  selectionChanged: boolean;
}

let activeGesture: ActiveGesture | null = null;
let gestureCleanupTimer: number | null = null;

function truncate(value: string, length = 80): string {
  return value.length > length ? `${value.slice(0, length - 1)}…` : value;
}

function describeElement(element: Element): string {
  const html = element as HTMLElement;
  const tag = element.tagName.toLowerCase();
  const id = element.id ? `#${element.id}` : "";
  const testId = html.dataset.testid ? `[testid=${html.dataset.testid}]` : "";
  const label =
    element.getAttribute("aria-label") ??
    element.getAttribute("title") ??
    element.textContent?.trim() ??
    "";
  let elementId = elementIds.get(element);
  if (!elementId) {
    elementSequence += 1;
    elementId = elementSequence;
    elementIds.set(element, elementId);
  }
  return `${tag}@${elementId}${id}${testId}${label ? `(${truncate(label)})` : ""}`;
}

function describeReference(element: Element): string {
  const html = element as HTMLElement;
  if (html.dataset.testid === "local-file-reference-link") {
    const location = [html.dataset.fileLine, html.dataset.fileColumn]
      .filter(Boolean)
      .join(":");
    return `file:${html.dataset.filePath ?? "?"}${location ? `:${location}` : ""}`;
  }
  return `entity:${html.dataset.vtbEntityType ?? "?"}:${html.dataset.vtbEntityId ?? "?"}`;
}

function actionableReferencesForEvent(event: MouseEvent): Element[] {
  const references = new Set<Element>();
  for (const target of event.composedPath()) {
    if (
      target instanceof Element &&
      target.matches(ACTIONABLE_REFERENCE_SELECTOR)
    ) {
      references.add(target);
    }
  }

  for (const candidate of document.querySelectorAll(
    ACTIONABLE_REFERENCE_SELECTOR
  )) {
    const rect = candidate.getBoundingClientRect();
    if (
      rect.width > 0 &&
      rect.height > 0 &&
      event.clientX >= rect.left &&
      event.clientX <= rect.right &&
      event.clientY >= rect.top &&
      event.clientY <= rect.bottom
    ) {
      references.add(candidate);
    }
  }
  return [...references];
}

function eventPointerDetails(event: MouseEvent): string {
  if (!(event instanceof PointerEvent)) return "";
  return ` pointerId=${event.pointerId} pointerType=${event.pointerType}`;
}

function traceEvent(event: Event): void {
  if (!(event instanceof MouseEvent)) return;
  const references = actionableReferencesForEvent(event);
  if (references.length === 0 && !activeGesture) return;

  if (event.type === "pointerdown" && event instanceof PointerEvent) {
    if (gestureCleanupTimer !== null) {
      window.clearTimeout(gestureCleanupTimer);
      gestureCleanupTimer = null;
    }
    clickSequence += 1;
    const downReference = references[0];
    if (downReference) {
      activeGesture = {
        pointerId: event.pointerId,
        downTarget: event.target,
        downReference,
        startX: event.clientX,
        startY: event.clientY,
        maxMovement: 0,
        selectionChanged: false,
      };
    }
  } else if (event.type === "mousedown" && !("PointerEvent" in window)) {
    clickSequence += 1;
  }

  if (
    activeGesture &&
    event instanceof PointerEvent &&
    event.pointerId === activeGesture.pointerId
  ) {
    activeGesture.maxMovement = Math.max(
      activeGesture.maxMovement,
      Math.hypot(
        event.clientX - activeGesture.startX,
        event.clientY - activeGesture.startY
      )
    );
  }
  const sequence = clickSequence;
  const hitStack = document
    .elementsFromPoint(event.clientX, event.clientY)
    .slice(0, 6)
    .map(describeElement)
    .join(" > ");
  const path = event
    .composedPath()
    .filter((target): target is Element => target instanceof Element)
    .slice(0, 8)
    .map(describeElement)
    .join(" > ");

  const gesture = activeGesture
    ? ` downTarget=${activeGesture.downTarget instanceof Element ? describeElement(activeGesture.downTarget) : String(activeGesture.downTarget)} sameTarget=${event.target === activeGesture.downTarget} downTargetConnected=${activeGesture.downTarget instanceof Element ? activeGesture.downTarget.isConnected : "n/a"} downRef=${describeElement(activeGesture.downReference)} sameRef=${references.includes(activeGesture.downReference)} downRefConnected=${activeGesture.downReference.isConnected} maxMovement=${activeGesture.maxMovement.toFixed(2)} selectionChanged=${activeGesture.selectionChanged}`
    : "";

  addDebugLog(
    `[CLICK_TRACE] capture seq=${sequence} event=${event.type} trusted=${event.isTrusted} button=${event.button} buttons=${event.buttons}${eventPointerDetails(event)} client=${event.clientX},${event.clientY} target=${event.target instanceof Element ? describeElement(event.target) : String(event.target)} refs=${references.map(describeReference).join(",") || "none"}${gesture} hit=${hitStack || "none"} path=${path || "none"} defaultPrevented=${event.defaultPrevented}`
  );

  queueMicrotask(() => {
    addDebugLog(
      `[CLICK_TRACE] settled seq=${sequence} event=${event.type} defaultPrevented=${event.defaultPrevented} cancelBubble=${event.cancelBubble}`
    );
  });

  if (event.type === "click" || event.type === "pointercancel") {
    activeGesture = null;
  } else if (event.type === "pointerup" && activeGesture) {
    const completedGesture = activeGesture;
    gestureCleanupTimer = window.setTimeout(() => {
      if (activeGesture === completedGesture) activeGesture = null;
      gestureCleanupTimer = null;
    }, 100);
  }
}

function trackPointerMove(event: PointerEvent): void {
  if (!activeGesture || event.pointerId !== activeGesture.pointerId) return;
  activeGesture.maxMovement = Math.max(
    activeGesture.maxMovement,
    Math.hypot(
      event.clientX - activeGesture.startX,
      event.clientY - activeGesture.startY
    )
  );
}

function traceSelectionChange(): void {
  if (!activeGesture) return;
  if (activeGesture.selectionChanged) return;
  activeGesture.selectionChanged = true;
  const selection = document.getSelection();
  addDebugLog(
    `[CLICK_TRACE] selection seq=${clickSequence} type=${selection?.type ?? "none"} text=${JSON.stringify(truncate(selection?.toString() ?? "", 120))}`
  );
}

export function installActionableReferenceClickDiagnostics(): () => void {
  for (const eventType of EVENT_TYPES) {
    window.addEventListener(eventType, traceEvent, { capture: true });
  }
  window.addEventListener("pointermove", trackPointerMove, { capture: true });
  document.addEventListener("selectionchange", traceSelectionChange, {
    capture: true,
  });
  return () => {
    if (gestureCleanupTimer !== null) {
      window.clearTimeout(gestureCleanupTimer);
      gestureCleanupTimer = null;
    }
    activeGesture = null;
    for (const eventType of EVENT_TYPES) {
      window.removeEventListener(eventType, traceEvent, { capture: true });
    }
    window.removeEventListener("pointermove", trackPointerMove, {
      capture: true,
    });
    document.removeEventListener("selectionchange", traceSelectionChange, {
      capture: true,
    });
  };
}
