import { addDebugLog } from "./debugLog";

const ACTIONABLE_REFERENCE_SELECTOR = [
  '[data-testid="local-file-reference-link"]',
  '[data-testid="vtb-entity-link"]',
].join(",");

const MAX_CLICK_MOVEMENT_PX = 6;

interface PendingPress {
  pointerId: number;
  referenceKey: string;
  reference: HTMLElement;
  startX: number;
  startY: number;
  maxMovement: number;
  dragged: boolean;
  recoveryTimer: number | null;
}

function referenceFromEvent(event: MouseEvent): HTMLElement | null {
  for (const target of event.composedPath()) {
    if (
      target instanceof HTMLElement &&
      target.matches(ACTIONABLE_REFERENCE_SELECTOR)
    ) {
      return target;
    }
  }

  return (
    document
      .elementsFromPoint(event.clientX, event.clientY)
      .find(
        (element): element is HTMLElement =>
          element instanceof HTMLElement &&
          element.matches(ACTIONABLE_REFERENCE_SELECTOR)
      ) ?? null
  );
}

function referenceKey(reference: HTMLElement): string {
  if (reference.dataset.testid === "local-file-reference-link") {
    return [
      "file",
      reference.dataset.filePath ?? "",
      reference.dataset.fileLine ?? "",
      reference.dataset.fileColumn ?? "",
    ].join(":");
  }

  return [
    "entity",
    reference.dataset.vtbEntityType ?? "",
    reference.dataset.vtbEntityId ?? "",
  ].join(":");
}

function movementFromStart(press: PendingPress, event: MouseEvent): number {
  return Math.hypot(event.clientX - press.startX, event.clientY - press.startY);
}

function clearRecoveryTimer(press: PendingPress): void {
  if (press.recoveryTimer === null) return;
  window.clearTimeout(press.recoveryTimer);
  press.recoveryTimer = null;
}

/**
 * WebKit can occasionally deliver a complete primary mouse press to an
 * actionable reference without synthesizing the final click. Recover only
 * clean, stationary presses and route them through the element's existing
 * click handler after the native click window has passed.
 */
export function installActionableReferenceClickRecovery(): () => void {
  let pendingPress: PendingPress | null = null;

  const clearPendingPress = () => {
    if (!pendingPress) return;
    clearRecoveryTimer(pendingPress);
    pendingPress = null;
  };

  const onPointerDown = (event: PointerEvent) => {
    clearPendingPress();
    if (
      event.pointerType !== "mouse" ||
      !event.isPrimary ||
      event.button !== 0 ||
      event.metaKey ||
      event.altKey ||
      event.ctrlKey ||
      event.shiftKey
    ) {
      return;
    }

    const reference = referenceFromEvent(event);
    if (!reference) return;
    pendingPress = {
      pointerId: event.pointerId,
      referenceKey: referenceKey(reference),
      reference,
      startX: event.clientX,
      startY: event.clientY,
      maxMovement: 0,
      dragged: false,
      recoveryTimer: null,
    };
  };

  const onPointerMove = (event: PointerEvent) => {
    if (!pendingPress || event.pointerId !== pendingPress.pointerId) return;
    pendingPress.maxMovement = Math.max(
      pendingPress.maxMovement,
      movementFromStart(pendingPress, event)
    );
  };

  const onDragStart = () => {
    if (pendingPress) pendingPress.dragged = true;
  };

  const onPointerCancel = (event: PointerEvent) => {
    if (!pendingPress || event.pointerId !== pendingPress.pointerId) return;
    addDebugLog(
      `[CLICK_RECOVERY] cancelled ref=${pendingPress.referenceKey} reason=pointercancel`
    );
    clearPendingPress();
  };

  const onPointerUp = (event: PointerEvent) => {
    const press = pendingPress;
    if (!press || event.pointerId !== press.pointerId) return;

    press.maxMovement = Math.max(
      press.maxMovement,
      movementFromStart(press, event)
    );
    const releasedReference = referenceFromEvent(event);
    const releasedKey = releasedReference
      ? referenceKey(releasedReference)
      : "none";
    const canRecover =
      event.button === 0 &&
      !press.dragged &&
      press.maxMovement <= MAX_CLICK_MOVEMENT_PX &&
      releasedKey === press.referenceKey;

    addDebugLog(
      `[CLICK_RECOVERY] pointerup ref=${press.referenceKey} released=${releasedKey} movement=${press.maxMovement.toFixed(2)} dragged=${press.dragged} originalConnected=${press.reference.isConnected} recoverable=${canRecover}`
    );

    if (!canRecover) {
      clearPendingPress();
      return;
    }

    const recoveryTarget = releasedReference ?? press.reference;
    press.recoveryTimer = window.setTimeout(() => {
      if (pendingPress !== press) return;
      pendingPress = null;
      press.recoveryTimer = null;
      if (!recoveryTarget.isConnected) {
        addDebugLog(
          `[CLICK_RECOVERY] skipped ref=${press.referenceKey} reason=disconnected`
        );
        return;
      }
      addDebugLog(
        `[CLICK_RECOVERY] synthesizing missing click ref=${press.referenceKey}`
      );
      recoveryTarget.click();
    }, 0);
  };

  const onClick = (event: MouseEvent) => {
    const press = pendingPress;
    if (!press) return;
    const clickedReference = referenceFromEvent(event);
    if (
      !clickedReference ||
      referenceKey(clickedReference) !== press.referenceKey
    ) {
      return;
    }
    addDebugLog(
      `[CLICK_RECOVERY] click observed ref=${press.referenceKey} trusted=${event.isTrusted}; recovery not needed`
    );
    clearPendingPress();
  };

  window.addEventListener("pointerdown", onPointerDown, true);
  window.addEventListener("pointermove", onPointerMove, true);
  window.addEventListener("pointerup", onPointerUp, true);
  window.addEventListener("pointercancel", onPointerCancel, true);
  window.addEventListener("dragstart", onDragStart, true);
  window.addEventListener("click", onClick, true);

  return () => {
    clearPendingPress();
    window.removeEventListener("pointerdown", onPointerDown, true);
    window.removeEventListener("pointermove", onPointerMove, true);
    window.removeEventListener("pointerup", onPointerUp, true);
    window.removeEventListener("pointercancel", onPointerCancel, true);
    window.removeEventListener("dragstart", onDragStart, true);
    window.removeEventListener("click", onClick, true);
  };
}
