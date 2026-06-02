import { useWorkflows } from "../hooks/useWorkflows";
import { WorkflowGrid } from "../components/WorkflowGrid";

/**
 * WorkflowsPage displays all workflows with neural-pathway design.
 * Automatically refreshes when workflow change events are received via GlobalListeners.
 */
export function WorkflowsPage() {
  const { workflows, isLoading, error } = useWorkflows();

  return (
    <div className="relative flex-1 space-y-6 overflow-auto p-6">
      {/* Neural grid background */}
      <div className="neural-grid pointer-events-none absolute inset-0 opacity-20" />

      <div>
        <h2 className="text-lg font-semibold text-fg">Workflows</h2>
        <p className="mt-1 text-sm text-fg-mute">
          Manage automation pipelines
        </p>
      </div>

      <div className="relative">
        <WorkflowGrid
          workflows={workflows}
          isLoading={isLoading}
          error={error}
        />
      </div>
    </div>
  );
}
