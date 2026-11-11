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
  /** A part gained pointer hover or keyboard focus (`null` when it left). */
  readonly onInspectPart?: (id: string | null) => void;
  /** Click, or Enter/Space on a focused card: follow it. */
  readonly onActivateCard?: (id: string) => void;
  /** Part drawn as selected (pinned in the inspector). */
  readonly activePart?: string | null;
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
