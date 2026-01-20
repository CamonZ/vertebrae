import type { Step } from "../../bindings";
import { ResizablePanel } from "../ResizablePanel";

interface StepDetailPanelProps {
  step: Step | null;
  onClose?: () => void;
}

/**
 * Detail row component for displaying key-value pairs
 */
function DetailRow({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-start justify-between gap-4 py-2">
      <span className="flex-shrink-0 font-mono text-[10px] uppercase tracking-wider text-text-muted">
        {label}
      </span>
      <span className="text-right text-sm text-text-primary">{children}</span>
    </div>
  );
}

/**
 * Section header component
 */
function SectionHeader({ title }: { title: string }) {
  return (
    <h3 className="mb-2 font-mono text-[10px] uppercase tracking-wider text-text-muted">
      {title}
    </h3>
  );
}

/**
 * Tag list component for displaying arrays of strings
 */
function TagList({ items, emptyText }: { items: string[]; emptyText: string }) {
  if (items.length === 0) {
    return <span className="text-xs italic text-text-muted">{emptyText}</span>;
  }

  return (
    <div className="flex flex-wrap gap-1.5">
      {items.map((item, index) => (
        <span
          key={`${item}-${index}`}
          className="rounded-full border border-border bg-bg-tertiary px-2 py-0.5 font-mono text-xs text-text-secondary"
        >
          {item}
        </span>
      ))}
    </div>
  );
}

/**
 * StepDetailPanel displays workflow step configuration in a side panel.
 * Shows all AgentConfig fields including model, prompts, tools, and permissions.
 */
export function StepDetailPanel({ step, onClose }: StepDetailPanelProps) {
  if (!step) {
    return null;
  }

  const { agent_config } = step;
  const hasSystemPrompt = Boolean(
    agent_config.system_prompt || agent_config.append_system_prompt
  );
  const totalTools =
    agent_config.tools.length + agent_config.allowed_tools.length;

  return (
    <ResizablePanel
      storageKey="step-detail-panel-width"
      glowColor="from-info/0 via-info/30 to-info/0"
    >
      {/* Header */}
      <div className="flex items-center justify-between border-b border-border px-4 py-3">
        <h2 className="font-mono text-xs font-medium uppercase tracking-wider text-text-muted">
          Step Configuration
        </h2>
        {onClose && (
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg p-1.5 text-text-muted transition-colors hover:bg-bg-hover hover:text-text-primary focus:outline-none focus-visible:ring-2 focus-visible:ring-primary"
            aria-label="Close panel"
          >
            <svg
              className="h-4 w-4"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={1.5}
                d="M6 18L18 6M6 6l12 12"
              />
            </svg>
          </button>
        )}
      </div>

      {/* Step title */}
      <div className="border-b border-border px-4 py-3">
        <div className="flex items-center gap-3">
          <span className="flex h-8 w-8 items-center justify-center rounded-lg border border-primary/30 bg-primary/10 font-mono text-sm font-bold text-primary">
            {step.order + 1}
          </span>
          <div>
            <h3 className="text-sm font-semibold text-text-primary">
              {step.name}
            </h3>
            <p className="mt-0.5 text-xs text-text-muted">
              Step {step.order + 1} in workflow
            </p>
          </div>
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 divide-y divide-border overflow-auto">
        {/* Model Configuration */}
        <div className="p-4">
          <SectionHeader title="Model" />
          <div className="space-y-1">
            <DetailRow label="Primary">
              {agent_config.model ? (
                <code className="rounded bg-bg-tertiary px-1.5 py-0.5 font-mono text-xs">
                  {agent_config.model}
                </code>
              ) : (
                <span className="text-xs italic text-text-muted">Default</span>
              )}
            </DetailRow>
            {agent_config.fallback_model && (
              <DetailRow label="Fallback">
                <code className="rounded bg-bg-tertiary px-1.5 py-0.5 font-mono text-xs">
                  {agent_config.fallback_model}
                </code>
              </DetailRow>
            )}
          </div>
        </div>

        {/* System Prompt */}
        {hasSystemPrompt && (
          <div className="p-4">
            <SectionHeader title="System Prompt" />
            {agent_config.system_prompt && (
              <div className="mb-3">
                <p className="mb-1 text-[10px] uppercase text-text-muted">
                  Override
                </p>
                <div className="max-h-32 overflow-auto rounded-lg border border-border bg-bg-tertiary p-2">
                  <pre className="whitespace-pre-wrap font-mono text-xs text-text-secondary">
                    {agent_config.system_prompt}
                  </pre>
                </div>
              </div>
            )}
            {agent_config.append_system_prompt && (
              <div>
                <p className="mb-1 text-[10px] uppercase text-text-muted">
                  Append
                </p>
                <div className="max-h-32 overflow-auto rounded-lg border border-border bg-bg-tertiary p-2">
                  <pre className="whitespace-pre-wrap font-mono text-xs text-text-secondary">
                    {agent_config.append_system_prompt}
                  </pre>
                </div>
              </div>
            )}
          </div>
        )}

        {/* Tools */}
        <div className="p-4">
          <SectionHeader title={`Tools (${totalTools})`} />
          <div className="space-y-3">
            {agent_config.tools.length > 0 && (
              <div>
                <p className="mb-1.5 text-[10px] uppercase text-text-muted">
                  Built-in Tools
                </p>
                <TagList items={agent_config.tools} emptyText="None" />
              </div>
            )}
            {agent_config.allowed_tools.length > 0 && (
              <div>
                <p className="mb-1.5 text-[10px] uppercase text-text-muted">
                  Allowed
                </p>
                <TagList items={agent_config.allowed_tools} emptyText="None" />
              </div>
            )}
            {agent_config.disallowed_tools.length > 0 && (
              <div>
                <p className="mb-1.5 text-[10px] uppercase text-text-muted">
                  Disallowed
                </p>
                <div className="flex flex-wrap gap-1.5">
                  {agent_config.disallowed_tools.map((tool, index) => (
                    <span
                      key={`${tool}-${index}`}
                      className="rounded-full border border-error/30 bg-error/10 px-2 py-0.5 font-mono text-xs text-error"
                    >
                      {tool}
                    </span>
                  ))}
                </div>
              </div>
            )}
            {totalTools === 0 &&
              agent_config.disallowed_tools.length === 0 && (
                <span className="text-xs italic text-text-muted">
                  Using default tools
                </span>
              )}
          </div>
        </div>

        {/* Permissions */}
        <div className="p-4">
          <SectionHeader title="Permissions" />
          <div className="space-y-1">
            <DetailRow label="Mode">
              {agent_config.permission_mode ? (
                <span
                  className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${
                    agent_config.permission_mode === "default"
                      ? "bg-bg-tertiary text-text-secondary"
                      : agent_config.permission_mode === "plan"
                        ? "bg-info/10 text-info"
                        : agent_config.permission_mode === "bypass_permissions"
                          ? "bg-warning/10 text-warning"
                          : "bg-bg-tertiary text-text-secondary"
                  }`}
                >
                  {agent_config.permission_mode}
                </span>
              ) : (
                <span className="text-xs italic text-text-muted">Default</span>
              )}
            </DetailRow>
            {agent_config.max_budget_usd != null && (
              <DetailRow label="Budget">
                <span className="font-mono text-xs">
                  ${agent_config.max_budget_usd.toFixed(2)}
                </span>
              </DetailRow>
            )}
          </div>
        </div>

        {/* MCP Configuration */}
        {agent_config.mcp_config.length > 0 && (
          <div className="p-4">
            <SectionHeader title="MCP Servers" />
            <TagList
              items={agent_config.mcp_config}
              emptyText="No MCP servers"
            />
          </div>
        )}

        {/* Plugin Directories */}
        {agent_config.plugin_dirs.length > 0 && (
          <div className="p-4">
            <SectionHeader title="Plugin Directories" />
            <div className="space-y-1">
              {agent_config.plugin_dirs.map((dir, index) => (
                <code
                  key={`${dir}-${index}`}
                  className="block rounded bg-bg-tertiary px-2 py-1 font-mono text-xs text-text-secondary"
                >
                  {dir}
                </code>
              ))}
            </div>
          </div>
        )}

        {/* Custom Agents */}
        {agent_config.agents && (
          <div className="p-4">
            <SectionHeader title="Custom Agents" />
            <div className="max-h-32 overflow-auto rounded-lg border border-border bg-bg-tertiary p-2">
              <pre className="whitespace-pre-wrap font-mono text-xs text-text-secondary">
                {agent_config.agents}
              </pre>
            </div>
          </div>
        )}

        {/* JSON Schema */}
        {agent_config.json_schema && (
          <div className="p-4">
            <SectionHeader title="Output Schema" />
            <div className="max-h-32 overflow-auto rounded-lg border border-border bg-bg-tertiary p-2">
              <pre className="whitespace-pre-wrap font-mono text-xs text-text-secondary">
                {agent_config.json_schema}
              </pre>
            </div>
          </div>
        )}
      </div>
    </ResizablePanel>
  );
}
