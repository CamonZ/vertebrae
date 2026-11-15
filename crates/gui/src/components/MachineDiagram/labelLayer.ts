import { createContext } from "react";

/** Configured flow headers paint above rails, parts and travelling cards. */
export const LabelLayerContext = createContext<SVGGElement | null>(null);
