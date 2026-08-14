import {
  Children,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
} from "react";
import { useInRouterContext, useNavigate } from "react-router-dom";
import { useEntityPanelStore } from "../../stores/entityPanelStore";
import { addDebugLog } from "../../utils/debugLog";
import { LevelMark } from "./LevelMark";
import type { VtbEntityTarget } from "./vtbEntityLinkTarget";

interface VtbEntityLinkProps {
  target: VtbEntityTarget;
  children: ReactNode;
  onOpen: (target: VtbEntityTarget) => void;
}

function typeLabel(type: VtbEntityTarget["type"]): string {
  return type.charAt(0).toUpperCase() + type.slice(1);
}

function hasRenderableChildren(children: ReactNode): boolean {
  return Children.toArray(children).some((child) => {
    if (child == null || typeof child === "boolean") return false;
    if (typeof child === "string") return child.trim().length > 0;
    return true;
  });
}

export function VtbEntityLink({
  target,
  children,
  onOpen,
}: VtbEntityLinkProps) {
  const label = typeLabel(target.type);
  const hasLabel = hasRenderableChildren(children);

  const handleClick = (event: MouseEvent<HTMLAnchorElement>) => {
    addDebugLog(
      `[ENTITY_LINK] click received type=${target.type} id=${target.id} button=${event.button} defaultPrevented=${event.defaultPrevented} modifiers=${event.metaKey || event.altKey || event.ctrlKey || event.shiftKey}`
    );
    if (
      event.defaultPrevented ||
      event.button !== 0 ||
      event.metaKey ||
      event.altKey ||
      event.ctrlKey ||
      event.shiftKey
    ) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    addDebugLog(`[ENTITY_LINK] opening route=${target.route}`);
    onOpen(target);
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLAnchorElement>) => {
    if (event.key === " ") {
      event.preventDefault();
      event.stopPropagation();
      onOpen(target);
    }
  };

  return (
    <a
      href={target.route}
      title={`Open ${label}`}
      aria-label={`Open ${target.type} ${target.id}`}
      data-testid="vtb-entity-link"
      data-actionable-reference="entity"
      data-vtb-entity-type={target.type}
      data-vtb-entity-id={target.id}
      data-full-id={target.id}
      data-vtb-route={target.route}
      onClick={handleClick}
      onKeyDown={handleKeyDown}
      className="inline-flex cursor-pointer items-center gap-1 rounded-sm align-baseline text-accent underline decoration-accent/30 outline-none hover:decoration-accent focus-visible:ring-2 focus-visible:ring-accent"
    >
      {target.level && (
        <LevelMark
          level={target.level}
          className="pointer-events-none h-3.5 w-3.5"
          testId="vtb-entity-level-mark"
        />
      )}
      <span className="pointer-events-none text-[0.95em] leading-none">
        {hasLabel ? children : label}
      </span>
    </a>
  );
}

function openTargetPanel(target: VtbEntityTarget): boolean {
  const store = useEntityPanelStore.getState();
  switch (target.type) {
    case "epic":
    case "ticket":
    case "task":
      store.openTask(target.id);
      addDebugLog(`[ENTITY_LINK] opened task panel id=${target.id}`);
      return true;
    case "workflow":
      store.openWorkflow(target.id);
      addDebugLog(`[ENTITY_LINK] opened workflow panel id=${target.id}`);
      return true;
    case "step":
      store.openStep(target.id);
      addDebugLog(`[ENTITY_LINK] opened step panel id=${target.id}`);
      return true;
    case "project":
      addDebugLog(`[ENTITY_LINK] navigating project route=${target.route}`);
      return false;
  }
}

function BrowserVtbEntityLink({
  target,
  children,
}: Omit<VtbEntityLinkProps, "onOpen">) {
  return (
    <VtbEntityLink
      target={target}
      onOpen={(opened) => {
        if (openTargetPanel(opened)) return;
        window.location.href = opened.route;
      }}
    >
      {children}
    </VtbEntityLink>
  );
}

function RoutedVtbEntityLink({
  target,
  children,
}: Omit<VtbEntityLinkProps, "onOpen">) {
  const navigate = useNavigate();
  return (
    <VtbEntityLink
      target={target}
      onOpen={(opened) => {
        if (openTargetPanel(opened)) return;
        navigate(opened.route);
      }}
    >
      {children}
    </VtbEntityLink>
  );
}

export function VtbEntityMarkdownLink({
  target,
  children,
}: Omit<VtbEntityLinkProps, "onOpen">) {
  return useInRouterContext() ? (
    <RoutedVtbEntityLink target={target}>{children}</RoutedVtbEntityLink>
  ) : (
    <BrowserVtbEntityLink target={target}>{children}</BrowserVtbEntityLink>
  );
}
