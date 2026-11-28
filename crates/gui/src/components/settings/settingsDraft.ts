import type {
  SettingsEdit,
  AcpAgentSettings,
  SharedSettings,
  ProviderSettings,
} from "../../bindings";
import type { SecretEdit } from "../../bindings";
import type { SettingsValidation } from "./settingsValidation";
const RESERVED_PROVIDER_IDS = new Set([
  "anthropic", "claude", "openai", "codex", "typesafe", "type-safe",
  "type_safe", "systemone", "system-one", "system_one", "acp",
]);

export const keep: SecretEdit = { action: "keep" };
export type ConfigSection =
  | "providers"
  | "connection"
  | "observability"
  | "decision_model";
export interface AcpAgentDraft {
  id: string;
  name: string;
  executable: string;
  models: string;
  default_model: string;
  args: { id: string; value: string }[];
}

export type SettingsDraft =
  | Exclude<SettingsEdit, { section: "acp_agent" | "remove_acp_agent" }>
  | { section: "acp_agent"; settings: AcpAgentDraft; create: boolean; remove?: boolean };

export function acpAgentDraft(agent?: AcpAgentSettings | null): SettingsDraft {
  return {
    section: "acp_agent",
    create: !agent,
    settings: {
      id: agent?.id ?? "",
      name: agent?.name ?? "",
      executable: agent?.executable ?? "",
      models: (agent?.models ?? []).join(", "),
      default_model: agent?.default_model ?? "",
      args: (agent?.args ?? []).map((value) => ({
        id: crypto.randomUUID(),
        value,
      })),
    },
  };
}

export function settingsEdit(draft: SettingsDraft): SettingsEdit {
  if (draft.section !== "acp_agent") return draft;
  if (draft.remove) return { section: "remove_acp_agent", id: draft.settings.id };
  const { args, models, ...settings } = draft.settings;
  return {
    section: "acp_agent",
    create: draft.create,
    settings: { ...settings, models: models.split(",").map((model) => model.trim()).filter(Boolean), args: args.map(({ value }) => value) },
  };
}

export function draftFor(
  section: ConfigSection,
  settings: SharedSettings
): SettingsDraft {
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
function validateModelSelection(
  models: string[],
  defaultModel: string,
  field: string
): SettingsValidation | null {
  const ids = models.map((model) => model.trim());
  if (new Set(ids).size !== ids.length)
    return { field, message: "Model IDs must be unique." };
  if (ids.length && defaultModel.trim() && !ids.includes(defaultModel.trim()))
    return { field: "Default model", message: "The default model must be in the model list." };
  return null;
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
  if (edit.section === "acp_agent") {
    const { id, name, executable, args } = edit.settings;
    if ((name.trim() || executable.trim()) &&
        (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(id) || RESERVED_PROVIDER_IDS.has(id))) {
      return error("Provider ID", "Enter a custom provider ID using lowercase letters, digits, hyphens or underscores.");
    }
    if ((executable.trim() || args.length) && !name.trim()) {
      return error("Provider name", "Enter a name for the ACP provider.");
    }
    const absolute = /^(?:[/]|[A-Za-z]:[/\\]|\\\\)/.test(executable);
    const command =
      executable !== "." && executable !== ".." && !/[/\\]/.test(executable);
    if (
      (!executable.trim() && (name.trim() || args.length > 0)) ||
      executable.includes("\0") ||
      (executable.trim() && !absolute && !command)
    ) {
      return error(
        "Agent executable",
        "Enter a command on PATH or an absolute executable path."
      );
    }
    const invalidArgument = args.findIndex((arg) => arg.includes("\0"));
    return invalidArgument < 0
      ? validateModelSelection(edit.settings.models ?? [], edit.settings.default_model ?? "", "Models")
      : error(
          `Argument ${invalidArgument + 1}`,
          "Arguments cannot contain a NUL character."
        );
  }
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
    if (RESERVED_PROVIDER_IDS.has(edit.id))
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
    const modelError = validateModelSelection(edit.models, edit.default_model, "Model IDs");
    if (modelError) return modelError;
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
