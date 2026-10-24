import type {
  SettingsEdit,
  SharedSettings,
  ProviderSettings,
} from "../../bindings";
import type { SecretEdit } from "../../bindings";
import type { SettingsValidation } from "./settingsValidation";
export const keep: SecretEdit = { action: "keep" };
export type ConfigSection =
  | "providers"
  | "connection"
  | "observability"
  | "decision_model";
export function draftFor(
  section: ConfigSection,
  settings: SharedSettings
): SettingsEdit {
  if (section === "decision_model")
    return {
      section,
      enabled: settings.decision_model.enabled,
      provider: settings.decision_model.provider,
      model: settings.decision_model.model,
    };
  if (section === "connection")
    return { section, url: settings.connection_url, token: keep };
  if (section === "observability")
    return { section, settings: structuredClone(settings.observability) };
  return { section: "typesafe", url: settings.typesafe_url, key: keep };
}
export function providerDraft(
  provider?: ProviderSettings
): Extract<SettingsEdit, { section: "provider" }> {
  return {
    section: "provider",
    id: provider?.id ?? "",
    create: !provider,
    harness: provider?.harness ?? "codex",
    endpoint: provider?.endpoint ?? "",
    models: provider?.models ?? [],
    default_model: provider?.default_model ?? "",
    api_key_env: provider?.api_key_env ?? "",
    key: keep,
    environment: [],
    wire_api: provider?.wire_api ?? "",
  };
}
function validEndpoint(value: string, optional = false) {
  if (!value.trim()) return optional;
  try {
    const url = new URL(value);
    return (
      ["http:", "https:"].includes(url.protocol) &&
      !!url.hostname &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash
    );
  } catch {
    return false;
  }
}
export function validateSettingsDraft(
  edit: SettingsEdit
): SettingsValidation | null {
  if (edit.section === "decision_model" && edit.enabled) {
    if (!edit.provider)
      return {
        field: "Decision provider",
        message: "Select a decision model provider.",
      };
    if (!edit.model.trim())
      return { field: "Decision model", message: "Select a decision model." };
  }
  const error = (field: string, message: string) => ({ field, message });
  const secret =
    edit.section === "connection"
      ? edit.token
      : edit.section === "typesafe" || edit.section === "provider"
        ? edit.key
        : keep;
  const secretLabel =
    edit.section === "connection"
      ? "backend token"
      : edit.section === "typesafe"
        ? "typesafe api key"
        : "provider api key";
  if (secret.action === "replace" && !secret.value.trim())
    return error(`New ${secretLabel}`, "Enter a replacement credential.");
  if (edit.section === "connection" && !validEndpoint(edit.url))
    return error(
      "Backend URL",
      "Enter a valid HTTP or HTTPS backend URL without embedded credentials, query parameters or fragments."
    );
  if (edit.section === "typesafe" && !validEndpoint(edit.url, true))
    return error(
      "System One endpoint",
      "Enter a valid TypeSafe endpoint, or leave it blank for the default."
    );
  if (
    edit.section === "observability" &&
    !validEndpoint(edit.settings.endpoint)
  )
    return error("Collector endpoint", "Enter a valid collector endpoint.");
  if (edit.section === "provider") {
    if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(edit.id))
      return error(
        "Provider ID",
        "Enter a provider ID using lowercase letters, digits, hyphens or underscores."
      );
    if (
      [
        "anthropic",
        "openai",
        "typesafe",
        "claude",
        "codex",
        "system-one",
        "mistral",
        "mistral_vibe",
      ].includes(edit.id)
    )
      return error(
        "Provider ID",
        "Choose a custom provider ID; built-in names are reserved."
      );
    if (!["claude", "codex", "typesafe"].includes(edit.harness))
      return error(
        "Harness",
        "This harness is not supported by the provider form."
      );
    if (!validEndpoint(edit.endpoint, true))
      return error(
        edit.harness === "typesafe" ? "System One endpoint" : "API base URL",
        "Enter a valid provider endpoint."
      );
    if (!edit.models.length || edit.models.some((v) => !v.trim()))
      return error(
        "Model IDs",
        "Add at least one model; model IDs cannot be blank."
      );
    if (new Set(edit.models.map((v) => v.trim())).size !== edit.models.length)
      return error("Model IDs", "Model IDs must be unique.");
    if (edit.default_model && !edit.models.includes(edit.default_model))
      return error(
        "Default model",
        "The default model must be in the model list."
      );
    const invalidEnvironment = edit.environment.find(
      (v) =>
        !v.name.trim() ||
        /[=\0]/.test(v.name) ||
        (v.secret.action === "replace" && !v.secret.value.trim())
    );
    if (invalidEnvironment)
      return error(
        `New environment: ${invalidEnvironment.name.toLowerCase()}`,
        "Complete the environment variable name and replacement value."
      );
  }
  return null;
}
