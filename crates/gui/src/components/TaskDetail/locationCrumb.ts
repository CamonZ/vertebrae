/** "Workflow › Step", showing a repeated label ("Backlog › Backlog") once. */
export function locationCrumb(workflow: string, step: string): string {
  return workflow === step ? step : `${workflow} › ${step}`;
}
