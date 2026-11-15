function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export function recoveredSpeedTier(status: unknown): string | undefined {
  // Preserve requested intent even when the provider temporarily falls back.
  const record = asRecord(status);
  const tier = record?.requested ?? record?.active;
  return tier === "fast" || tier === "default" ? tier : undefined;
}

/** Read only normalized, root-conversation metadata, newest snapshot first. */
export function replaySpeedTier(
  lines: string[],
  providerResumeId: string | null | undefined
): string | undefined {
  for (let index = lines.length - 1; index >= 0; index--) {
    try {
      const event = asRecord(JSON.parse(lines[index]));
      const data = asRecord(event?.data);
      if (
        event?.version !== 1 ||
        event?.type !== "session_started" ||
        data?.provider_resume_id !== providerResumeId
      )
        continue;
      const tier = recoveredSpeedTier(data?.speed_tier_status);
      if (tier !== undefined) return tier;
    } catch {
      // Legacy or malformed records carry no recoverable setting.
    }
  }
  return undefined;
}
