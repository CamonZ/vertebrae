import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach, vi } from "vitest";
import { queryClient } from "../query/queryClient";

const createStorageMock = (): Storage => {
  let store: Record<string, string> = {};

  Object.defineProperties(Storage.prototype, {
    length: {
      configurable: true,
      get() {
        return Object.keys(store).length;
      },
    },
    clear: {
      configurable: true,
      writable: true,
      value() {
        store = {};
      },
    },
    getItem: {
      configurable: true,
      writable: true,
      value(key: string) {
        return Object.prototype.hasOwnProperty.call(store, key)
          ? store[key]
          : null;
      },
    },
    key: {
      configurable: true,
      writable: true,
      value(index: number) {
        return Object.keys(store)[index] ?? null;
      },
    },
    removeItem: {
      configurable: true,
      writable: true,
      value(key: string) {
        delete store[key];
      },
    },
    setItem: {
      configurable: true,
      writable: true,
      value(key: string, value: string) {
        store[key] = String(value);
      },
    },
  });

  return Object.create(Storage.prototype) as Storage;
};

const testLocalStorage = createStorageMock();

// Node 25 exposes a global localStorage object without Web Storage methods
// unless it is launched with --localstorage-file. Install a browser-like
// storage object for jsdom tests and keep bare `localStorage` in sync with
// `window.localStorage` when the test runner uses separate globals.
Object.defineProperty(window, "localStorage", {
  configurable: true,
  value: testLocalStorage,
});

if (globalThis !== window) {
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    enumerable: true,
    get: () => window.localStorage,
  });
}

// Cleanup after each test
afterEach(() => {
  cleanup();
  queryClient.clear();
  localStorage.clear();
});

// Mock Tauri APIs
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(() => Promise.resolve(() => {})),
  emit: vi.fn(),
}));

// Mock ResizeObserver for React Flow
class ResizeObserverMock {
  observe() {}
  unobserve() {}
  disconnect() {}
}

globalThis.ResizeObserver =
  ResizeObserverMock as unknown as typeof ResizeObserver;

// Mock matchMedia
Object.defineProperty(window, "matchMedia", {
  writable: true,
  value: vi.fn().mockImplementation((query) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  })),
});
