/**
 * Paired with `elkWorkerUnshim`. `layout.worker.ts` imports this, then the
 * module that creates the shared `new ELK()`, then the unshim, before anything
 * else. When the first ELK instance loads elkjs's in-thread worker, a scope
 * with `self` but no `document` makes elkjs act as its own layout worker: it
 * takes over `self.onmessage` and exports nothing, so every layout fails with
 * "_Worker is not a constructor". A placeholder `document` during that load
 * makes it behave as it does on the main thread. The placeholder must not
 * outlive it, because other code (Vite's dev client) treats `document` as a DOM.
 */
export const PLACEHOLDER = Symbol.for("vertebrae.elkWorkerShim");
const scope = globalThis as { document?: unknown };
if (scope.document === undefined) scope.document = { [PLACEHOLDER]: true };
