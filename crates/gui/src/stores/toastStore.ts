import { create } from "zustand";
import type { ToastMessage, ToastType } from "../types";

interface ToastState {
  /** Currently displayed toasts */
  toasts: ToastMessage[];
}

interface ToastActions {
  /** Add a new toast notification */
  addToast: (message: string, type: ToastType, duration?: number) => void;
  /** Remove a toast by ID */
  removeToast: (id: string) => void;
  /** Clear all toasts */
  clearToasts: () => void;
}

export type ToastStore = ToastState & ToastActions;

/** Default toast duration in milliseconds */
const DEFAULT_DURATION = 4000;

/** Maximum number of toasts to show at once */
const MAX_TOASTS = 5;

let toastCounter = 0;

export const useToastStore = create<ToastStore>()((set, get) => ({
  // Initial state
  toasts: [],

  // Actions
  addToast: (message, type, duration = DEFAULT_DURATION) => {
    const id = `toast-${++toastCounter}`;
    const toast: ToastMessage = { id, message, type, duration };

    set((state) => {
      // Keep only the most recent toasts
      const newToasts = [...state.toasts, toast].slice(-MAX_TOASTS);
      return { toasts: newToasts };
    });

    // Auto-remove after duration
    if (duration > 0) {
      setTimeout(() => {
        get().removeToast(id);
      }, duration);
    }
  },

  removeToast: (id) => {
    set((state) => ({
      toasts: state.toasts.filter((t) => t.id !== id),
    }));
  },

  clearToasts: () => {
    set({ toasts: [] });
  },
}));
