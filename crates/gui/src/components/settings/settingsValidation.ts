import { createContext } from "react";
export interface SettingsValidation {
  field: string;
  message: string;
}
export const SettingsValidationContext =
  createContext<SettingsValidation | null>(null);
