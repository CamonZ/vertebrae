import { create } from "zustand";

/** The updater channel configured for this GUI build. */
export const GUI_UPDATE_CHANNEL = "release";
export const GUI_UPDATE_CHANNELS = ["master", "release"] as const;
export type GuiUpdateChannel = (typeof GUI_UPDATE_CHANNELS)[number];

export type GuiUpdateComponentKey = "gui" | "cli" | "daemon" | "gate";

export type GuiUpdateComponentStatus =
  | "current"
  | "ready"
  | "stale"
  | "unavailable"
  | "verification-failed";

/** Per-component metadata supplied by a verified release state. */
export interface GuiUpdateComponentInfo {
  /** Stable component key used by the signed component manifest. */
  key?: GuiUpdateComponentKey | string;
  /** Optional display/artifact name for compatibility with manifest fixtures. */
  name?: string;
  currentVersion?: string | null;
  current_version?: string | null;
  targetVersion?: string | null;
  target_version?: string | null;
  /** Component manifests call the target version simply `version`. */
  version?: string | null;
  status?: GuiUpdateComponentStatus | string | null;
}

export type GuiUpdateComponents =
  | Partial<Record<GuiUpdateComponentKey, GuiUpdateComponentInfo>>
  | GuiUpdateComponentInfo[];

/** Optional verification/preflight results for the review surface. */
export interface GuiUpdateVerificationInfo {
  signature?: string | null;
  preflight?: string | null;
  compatibility?: string | null;
  componentManifest?: string | null;
}

export interface GuiUpdateInfo {
  /** Optional for compatibility with one-shot callers; schedulers normalize it. */
  channel?: string;
  currentVersion: string;
  version: string;
  /** Release build identity; older GUI manifests may omit it. */
  build?: string | null;
  /** Publication date aliases used by updater and fixture metadata. */
  date?: string | null;
  publishedAt?: string | null;
  published_at?: string | null;
  /** Release note aliases used by updater and release fixtures. */
  releaseNotes?: string | null;
  notes?: string | null;
  components?: GuiUpdateComponents;
  verification?: GuiUpdateVerificationInfo;
}

export type GuiUpdateComponentState =
  | "pending"
  | "downloaded"
  | "verified"
  | "staged"
  | "activated"
  | "health_checked"
  | "pending_relaunch"
  | "rolled_back"
  | "failed";

export interface GuiUpdateComponentResult {
  component: GuiUpdateComponentKey | string;
  state: GuiUpdateComponentState;
  message: string;
}

export type GuiUpdateTransactionState =
  | "preflight"
  | "downloading"
  | "verifying"
  | "activating"
  | "health_checked"
  | "deferred_relaunch"
  | "success"
  | "partial_failure"
  | "retryable_failure";

export interface GuiUpdateTransactionResult {
  transaction_id: string | null;
  state: GuiUpdateTransactionState;
  channel: string;
  version: string;
  build: string;
  progress: GuiUpdateComponentResult[];
  compatibility: string;
  signature: string;
  hash: string;
  disk: string;
  component_readiness: string;
  daemon_service: string;
  recovery_action: string | null;
  restart_forced: boolean;
}

export type GuiUpdateApplyState =
  | { status: "idle" }
  | { status: "applying"; result: GuiUpdateTransactionResult | null }
  | { status: "success"; result: GuiUpdateTransactionResult }
  | { status: "partial_failure"; result: GuiUpdateTransactionResult }
  | { status: "retryable_failure"; result: GuiUpdateTransactionResult }
  | { status: "error"; message: string };

/** Signed metadata availability for one selectable update channel. */
export interface GuiUpdateChannelState {
  available: boolean;
  currentVersion: string | null;
  latestVersion: string | null;
  update: GuiUpdateInfo | null;
  error: string | null;
}

export type GuiUpdateStatus =
  | "idle"
  | "checking"
  | "available"
  | "current"
  | "error"
  | "stale"
  | "unavailable";

export interface GuiUpdateState {
  /** The result of the last successful signed manifest check, if any. */
  available: GuiUpdateInfo | null;
  /** The GUI version reported by the last successful check. */
  currentVersion: string | null;
  /** Whether a signed manifest check is currently in flight. */
  checking: boolean;
  /** The latest optional-check failure, without clearing the known result. */
  error: string | null;
  status: GuiUpdateStatus;
  /** Independent signed metadata state for each selectable channel. */
  channels: Record<GuiUpdateChannel, GuiUpdateChannelState>;
  /** Channel currently shown by Settings > Updates. */
  selectedChannel: GuiUpdateChannel;
  apply: GuiUpdateApplyState;
}

function initialChannelState(): GuiUpdateChannelState {
  return {
    available: false,
    currentVersion: null,
    latestVersion: null,
    update: null,
    error: null,
  };
}

function initialChannelStates(): Record<
  GuiUpdateChannel,
  GuiUpdateChannelState
> {
  return {
    master: initialChannelState(),
    release: initialChannelState(),
  };
}

export const initialGuiUpdateState: GuiUpdateState = {
  available: null,
  currentVersion: null,
  checking: false,
  error: null,
  status: "idle",
  channels: initialChannelStates(),
  selectedChannel: GUI_UPDATE_CHANNEL,
  apply: { status: "idle" },
};

export const useGuiUpdateStore = create<GuiUpdateState>()(() => ({
  ...initialGuiUpdateState,
}));

export function resetGuiUpdateState(): void {
  useGuiUpdateStore.setState({
    ...initialGuiUpdateState,
    channels: initialChannelStates(),
  });
}

/** Switch the Settings release view only to a channel with verified metadata. */
export function selectGuiUpdateChannel(channel: GuiUpdateChannel): void {
  const state = useGuiUpdateStore.getState();
  const channelState = state.channels[channel];
  if (!channelState?.available) return;

  useGuiUpdateStore.setState({
    selectedChannel: channel,
    available: channelState.update,
    currentVersion: channelState.currentVersion,
    error: channelState.error,
    status: channelState.update ? "available" : "current",
  });
}
