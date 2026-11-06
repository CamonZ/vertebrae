import { describe, expect, it } from "vitest";
import { inlineDiscussionCatalog as catalog } from "../test/inlineDiscussionCatalog";
import {
  readInlineDiscussionPreference,
  resolveDiscussionModel,
} from "./inlineDiscussionModel";

const main = {
  harness: "claude" as const,
  providerId: "anthropic",
  modelId: "opus",
};

const followPreference = { mode: "follow" as const };

describe("inline discussion choice", () => {
  it("inherits the main selection or pins and discloses its catalog default", () => {
    const selectedChoice = resolveDiscussionModel(
      followPreference,
      catalog,
      main
    );

    expect(selectedChoice).toMatchObject({
      providerId: "anthropic",
      modelId: "opus",
      label: "Anthropic · Opus",
      error: null,
    });

    const defaultSelection = { harness: "claude" as const };
    const defaultChoice = resolveDiscussionModel(
      followPreference,
      catalog,
      defaultSelection
    );

    expect(defaultChoice).toMatchObject({
      modelId: "sonnet",
      label: "Anthropic · Sonnet (provider default)",
    });
    expect(main.modelId).toBe("opus");
  });

  it("uses a dedicated provider's exact model catalog without modifying main settings", () => {
    const preference = {
      mode: "dedicated" as const,
      providerId: "custom",
      modelId: "dedicated",
    };
    const choice = resolveDiscussionModel(preference, catalog, main);

    expect(choice).toMatchObject({
      harness: "codex",
      providerId: "custom",
      modelId: "dedicated",
      error: null,
    });
    expect(main).toEqual({
      harness: "claude",
      providerId: "anthropic",
      modelId: "opus",
    });
  });

  it("fails closed on stale inherited models, unknown defaults and changed harnesses", () => {
    const staleSelection = { ...main, modelId: "stale" };
    const staleChoice = resolveDiscussionModel(
      followPreference,
      catalog,
      staleSelection
    );

    expect(staleChoice.error).toContain("Model stale");

    const harnessesWithoutDefaults = catalog.harnesses.map((info) => ({
      ...info,
      default_model_id: null,
    }));
    const catalogWithoutDefaults = {
      ...catalog,
      harnesses: harnessesWithoutDefaults,
    };
    const defaultSelection = { ...main, modelId: null };
    const defaultChoice = resolveDiscussionModel(
      followPreference,
      catalogWithoutDefaults,
      defaultSelection
    );

    expect(defaultChoice.error).toContain("Select an explicit model");

    const changedSelection = { ...main, harness: "codex" as const };
    const changedChoice = resolveDiscussionModel(
      followPreference,
      catalog,
      changedSelection
    );

    expect(changedChoice.error).toContain("configuration has changed");
  });

  it("retains inherited behavior for old installations and rejects malformed consequential settings", () => {
    const legacyPreference = readInlineDiscussionPreference(undefined);

    expect(legacyPreference).toEqual({ mode: "follow" });

    const malformedPreferences = [
      null,
      {},
      "dedicated",
      { mode: "dedicated", providerId: "custom" },
      { mode: "dedicated", providerId: "custom", modelId: " " },
    ];

    for (const value of malformedPreferences) {
      const preference = readInlineDiscussionPreference(value);

      expect(preference).toEqual({ mode: "invalid" });
    }
  });
});

it("retains effort and speed while dropping the removed custom personality setting", () => {
  const preference = {
    mode: "dedicated" as const,
    providerId: "custom",
    modelId: "dedicated",
    reasoningEffort: "high",
    speedTier: "fast",
    personality: "friendly",
  };
  const decoded = readInlineDiscussionPreference(preference);
  const choice = resolveDiscussionModel(decoded, catalog, main);

  const { personality: removedStyle, ...supportedPreference } = preference;

  expect(removedStyle).toBe("friendly");
  expect(decoded).toEqual(supportedPreference);
  expect(choice).toMatchObject({
    reasoningEffort: "high",
    speedTier: "fast",
    personality: null,
  });
  expect(choice.label).toContain("Reasoning effort: High");
  expect(choice.label).toContain("Speed tier: Fast");
  expect(choice.label).not.toContain("Friendly");

  for (const option of ["reasoningEffort", "speedTier"] as const) {
    const stale = { ...preference, [option]: "removed" };
    const invalid = { ...preference, [option]: 42 };
    const staleChoice = resolveDiscussionModel(stale, catalog, main);
    const invalidPreference = readInlineDiscussionPreference(invalid);

    expect(staleChoice.error).toContain("unavailable");
    expect(invalidPreference.mode).toBe("invalid");
  }
});

it("inherits main-chat options and blocks incompatible model combinations", () => {
  const selection = {
    harness: "codex" as const,
    providerId: "custom",
    modelId: "dedicated",
    reasoningEffort: "high",
    speedTier: "fast",
    personality: "friendly",
  };
  const inherited = resolveDiscussionModel(
    followPreference,
    catalog,
    selection
  );
  const incompatibleSelection = { ...selection, modelId: "plain" };
  const incompatible = resolveDiscussionModel(
    followPreference,
    catalog,
    incompatibleSelection
  );

  expect(inherited).toMatchObject({
    reasoningEffort: "high",
    speedTier: "fast",
    personality: "friendly",
  });
  expect(incompatible.error).toContain("unavailable");
});
