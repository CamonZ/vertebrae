import categories from "./categories.json";

export const activityNames = new Map(
  categories.map(({ label, title }) => [label, title])
);
