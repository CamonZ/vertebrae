import { useParams } from "react-router-dom";

export function WorkflowDetailPage() {
  const { id } = useParams<{ id: string }>();

  return (
    <div className="rounded-lg bg-bg-primary p-6 shadow-md">
      <h2 className="mb-4 text-xl font-semibold text-text-primary">
        Workflow Detail
      </h2>
      <p className="text-text-secondary">
        Workflow pipeline view for workflow ID: <code>{id}</code>
      </p>
      <p className="mt-2 text-text-secondary">
        This view will show the workflow steps in a visual pipeline.
      </p>
    </div>
  );
}
