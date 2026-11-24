import { createContext } from "react";

/**
 * Whether the turn that owns the rendered tool calls is still running. A
 * pending call only reads as "awaiting result" while this is true; once the
 * turn has ended the missing result is stale, not in flight.
 */
export const TurnLiveContext = createContext<boolean>(true);
