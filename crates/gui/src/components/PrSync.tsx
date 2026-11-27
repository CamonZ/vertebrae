import { useEffect } from "react";
import { retainPrSync } from "../stores/prSync";

/** Keeps the chats' PR links and checks current while the app runs. */
export function PrSync() {
  useEffect(() => retainPrSync(), []);
  return null;
}
