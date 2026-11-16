import { createContext, useContext } from "react";

/**
 * Opt-in interaction for parts and cards with spec ids. Without a provider
 * (catalogue gallery, stills) parts and cards stay plain pictures.
 */
export interface DiagramInteraction {
  /**
   * The one activation path for a part: click, or Enter/Space while it has
   * focus. Evidence panels and drill-down hook in here.
   */
  readonly onActivatePart?: (id: string) => void;
  /**
   * Opening a part (double-click, or Enter while it has focus) when the host
   * draws a level below it. Without it Enter activates like a click.
   */
  readonly onOpenPart?: (id: string) => void;
  /** A part gained pointer hover or keyboard focus (`null` when it left). */
  readonly onInspectPart?: (id: string | null) => void;
  /** Independent channels for hosts where pointer and keyboard traces overlap. */
  readonly onHoverPart?: (id: string | null) => void;
  readonly onFocusPart?: (id: string | null) => void;
  /** Click, or Enter/Space on a focused card: follow it. */
  readonly onActivateCard?: (id: string) => void;
  /** Part drawn as selected (pinned in the inspector). */
  readonly activePart?: string | null;
  /**
   * Part drawn as hovered from outside the diagram (a list beside it): it
   * shows its ring and hover labels as if the pointer were on it.
   */
  readonly pointedPart?: string | null;
  /** Card drawn highlighted wherever it is; other cards dim. */
  readonly followedCard?: string | null;
}

export const DiagramInteractionContext =
  createContext<DiagramInteraction | null>(null);

export const useDiagramInteraction = () =>
  useContext(DiagramInteractionContext);

/** Enter or Space, the keys that activate a focused part or card. */
export const isActivationKey = (key: string) =>
  key === "Enter" || key === " " || key === "Spacebar";
