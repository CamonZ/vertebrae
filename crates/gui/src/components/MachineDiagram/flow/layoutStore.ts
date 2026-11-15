/**
 * Persistent flow layouts. Level layouts are pure functions of their geometry
 * key, so a layout computed once can be reused by later requests, worker
 * restarts and app launches. Entries are keyed by a digest of the engine
 * stamp and the level key: changing the layout engine (a new build, or a
 * bump of `LAYOUT_ENGINE_VERSION`) makes every earlier entry unreachable,
 * and those entries are deleted the next time the store opens.
 *
 * The store is best effort. Where IndexedDB is unavailable (tests, other
 * hosts) or fails, layout simply recomputes.
 */
import type { LevelLayout } from "./compile";

/** Bump when layout output changes without a new build (rare: dev servers). */
export const LAYOUT_ENGINE_VERSION = 2;

declare const __FLOW_LAYOUT_BUILD__: string | undefined;

const STAMP = `${LAYOUT_ENGINE_VERSION}:${
  typeof __FLOW_LAYOUT_BUILD__ === "string" ? __FLOW_LAYOUT_BUILD__ : "unbuilt"
}`;
const DB_NAME = "vertebrae-flow-layouts";
const STORE = "levels";
/** Newest entries kept; older ones are pruned when the store opens. */
const MAX_ENTRIES = 2000;

export interface LayoutStore {
  get(id: string): Promise<LevelLayout | undefined>;
  put(id: string, layout: LevelLayout): Promise<void>;
}

let override: LayoutStore | null | undefined;
let opened: LayoutStore | null | undefined;

/** Replace the store (tests); `null` disables persistence, `undefined` restores the default. */
export function setLayoutStore(store: LayoutStore | null | undefined): void {
  override = store;
}

function currentStore(): LayoutStore | null {
  if (override !== undefined) return override;
  if (opened === undefined)
    opened = typeof indexedDB === "undefined" ? null : indexedDbStore();
  return opened;
}

async function digest(key: string): Promise<string> {
  const text = `${STAMP}\n${key}`;
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) return text;
  const hash = await subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(hash), (b) =>
    b.toString(16).padStart(2, "0")
  ).join("");
}

export async function readStoredLayout(
  key: string
): Promise<LevelLayout | undefined> {
  const store = currentStore();
  if (!store) return undefined;
  try {
    return await store.get(await digest(key));
  } catch {
    return undefined;
  }
}

export function writeStoredLayout(key: string, layout: LevelLayout): void {
  const store = currentStore();
  if (!store) return;
  digest(key)
    .then((id) => store.put(id, layout))
    .catch(() => undefined);
}

interface Entry {
  readonly id: string;
  readonly stamp: string;
  readonly at: number;
  readonly layout: LevelLayout;
}

const request = <T>(r: IDBRequest<T>) =>
  new Promise<T>((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });

function indexedDbStore(): LayoutStore {
  const db = new Promise<IDBDatabase>((resolve, reject) => {
    const open = indexedDB.open(DB_NAME, 1);
    open.onupgradeneeded = () => {
      const levels = open.result.createObjectStore(STORE, { keyPath: "id" });
      levels.createIndex("stamp", "stamp");
      levels.createIndex("at", "at");
    };
    open.onsuccess = () => resolve(open.result);
    open.onerror = () => reject(open.error);
  });
  void db.then(prune).catch(() => undefined);
  return {
    async get(id) {
      const tx = (await db).transaction(STORE, "readonly");
      const entry = await request<Entry | undefined>(
        tx.objectStore(STORE).get(id)
      );
      return entry?.stamp === STAMP ? entry.layout : undefined;
    },
    async put(id, layout) {
      const tx = (await db).transaction(STORE, "readwrite");
      const entry: Entry = { id, stamp: STAMP, at: Date.now(), layout };
      await request(tx.objectStore(STORE).put(entry));
    },
  };
}

/** Delete entries from other engine stamps, then the oldest beyond the cap. */
async function prune(db: IDBDatabase): Promise<void> {
  const tx = db.transaction(STORE, "readwrite");
  const levels = tx.objectStore(STORE);
  const stale = (range: IDBKeyRange) =>
    new Promise<void>((resolve, reject) => {
      const cursor = levels.index("stamp").openKeyCursor(range);
      cursor.onsuccess = () => {
        const c = cursor.result;
        if (!c) return resolve();
        levels.delete(c.primaryKey);
        c.continue();
      };
      cursor.onerror = () => reject(cursor.error);
    });
  await stale(IDBKeyRange.upperBound(STAMP, true));
  await stale(IDBKeyRange.lowerBound(STAMP, true));
  let excess = (await request(levels.count())) - MAX_ENTRIES;
  if (excess <= 0) return;
  await new Promise<void>((resolve, reject) => {
    const cursor = levels.index("at").openKeyCursor();
    cursor.onsuccess = () => {
      const c = cursor.result;
      if (!c || excess-- <= 0) return resolve();
      levels.delete(c.primaryKey);
      c.continue();
    };
    cursor.onerror = () => reject(cursor.error);
  });
}
