/**
 * Calculates layout for task stacks organized by dependency depth
 * Stack 0: Root tasks (no dependencies)
 * Stack 1: Tasks blocked only by root tasks
 * Stack 2: Tasks blocked by stack 1 tasks, etc.
 */
export interface TaskLayoutInfo {
  id: string;
  stackIndex: number; // Which stack (0 = roots, 1 = blocked by roots, etc)
  positionInStack: number; // Position within the stack (for stacking offset)
  totalInStack: number; // Total tasks in this stack
}

export interface TaskGraphNode {
  id: string;
  dependsOnIds: string[];
  dependentIds: string[];
}

export interface TaskStack {
  stackIndex: number;
  taskIds: string[];
}

/**
 * Calculate layout for task stacks based on dependency depth
 */
export function calculateTaskLayout(
  tasks: TaskGraphNode[]
): Map<string, TaskLayoutInfo> {
  const taskMap = new Map(tasks.map((t) => [t.id, t]));
  const layout = new Map<string, TaskLayoutInfo>();

  // Calculate depth for each task (how many dependencies it has)
  const getDepth = (taskId: string, visited = new Set<string>()): number => {
    if (visited.has(taskId)) return 0; // Cycle detection
    visited.add(taskId);

    const task = taskMap.get(taskId);
    if (!task || task.dependsOnIds.length === 0) return 0;

    const maxDepth = Math.max(
      ...task.dependsOnIds.map((id) => getDepth(id, new Set(visited)))
    );
    return maxDepth + 1;
  };

  // Group tasks by depth
  const stackMap = new Map<number, string[]>();

  tasks.forEach((task) => {
    const depth = getDepth(task.id);
    if (!stackMap.has(depth)) {
      stackMap.set(depth, []);
    }
    stackMap.get(depth)!.push(task.id);
  });

  // Assign positions within each stack
  const sortedStacks = Array.from(stackMap.keys()).sort((a, b) => a - b);

  sortedStacks.forEach((stackIndex) => {
    const taskIds = stackMap.get(stackIndex) || [];
    // Sort by number of dependents (tasks that block others come first)
    taskIds.sort((a, b) => {
      const taskA = taskMap.get(a)!;
      const taskB = taskMap.get(b)!;
      return taskB.dependentIds.length - taskA.dependentIds.length;
    });

    taskIds.forEach((taskId, positionInStack) => {
      layout.set(taskId, {
        id: taskId,
        stackIndex,
        positionInStack,
        totalInStack: taskIds.length,
      });
    });
  });

  return layout;
}

/**
 * Convert layout info to React Flow node positions
 * Tasks are stacked vertically, with stacks positioned horizontally
 */
export function getTaskNodePosition(
  layout: TaskLayoutInfo,
  stackSpacingX: number = 220,
  stackStartX: number = -550,
  stackOffsetY: number = 30 // Increased for more visible stacking
) {
  return {
    x: stackStartX + layout.stackIndex * stackSpacingX, // Horizontal position
    y: layout.positionInStack * stackOffsetY, // Vertical stack offset (overlapping)
  };
}

/**
 * Convert layout info to React Flow node position for workflow steps
 * Steps are positioned on the right side, horizontally
 */
export function getStepNodePosition(
  stepIndex: number,
  nodeSpacingX: number = 320,
  nodeY: number = 80
) {
  return {
    x: stepIndex * nodeSpacingX,
    y: nodeY,
  };
}

/**
 * Calculate animated position for a task currently executing in a step
 * Animates horizontally towards the step, positioned above/below it
 */
export function getExecutingTaskPosition(
  stepIndex: number,
  _stepNodeX: number,
  stepNodeY: number,
  taskDepth: number,
  totalSteps: number,
  nodeSpacingX: number = 320
) {
  // Position between the task area and the current step
  const stepX = stepIndex * nodeSpacingX;
  const offsetX = -200 - (totalSteps - stepIndex) * 100; // Animate towards step
  const offsetY = (taskDepth % 3) * 100 - 100; // Spread vertically above/below

  return {
    x: stepX + offsetX,
    y: stepNodeY + offsetY,
  };
}
