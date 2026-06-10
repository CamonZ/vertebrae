import type { TaskFilterOptions } from "../bindings";

export const queryKeys = {
  project: (generation: number) => ["project", generation] as const,
  tasks: {
    all: (generation: number) =>
      [...queryKeys.project(generation), "tasks"] as const,
    lists: (generation: number) =>
      [...queryKeys.tasks.all(generation), "list"] as const,
    list: (generation: number, filter: TaskFilterOptions | null) =>
      [...queryKeys.tasks.lists(generation), filter] as const,
    details: (generation: number) =>
      [...queryKeys.tasks.all(generation), "detail"] as const,
    detail: (generation: number, id: string) =>
      [...queryKeys.tasks.details(generation), id] as const,
  },
  workflows: {
    all: (generation: number) =>
      [...queryKeys.project(generation), "workflows"] as const,
    list: (generation: number) =>
      [...queryKeys.workflows.all(generation), "list"] as const,
    details: (generation: number) =>
      [...queryKeys.workflows.all(generation), "detail"] as const,
    detail: (generation: number, id: string) =>
      [...queryKeys.workflows.details(generation), id] as const,
  },
};
