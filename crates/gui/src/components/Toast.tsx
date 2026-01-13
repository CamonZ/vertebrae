import { useToastStore } from "../stores/toastStore";
import type { ToastType } from "../types";

/** Icon and color configuration for each toast type */
const toastConfig: Record<
  ToastType,
  { icon: string; bgClass: string; borderClass: string; textClass: string }
> = {
  success: {
    icon: "\u2713", // checkmark
    bgClass: "bg-green-500/10",
    borderClass: "border-green-500/30",
    textClass: "text-green-400",
  },
  error: {
    icon: "\u2717", // x mark
    bgClass: "bg-red-500/10",
    borderClass: "border-red-500/30",
    textClass: "text-red-400",
  },
  warning: {
    icon: "\u26A0", // warning sign
    bgClass: "bg-yellow-500/10",
    borderClass: "border-yellow-500/30",
    textClass: "text-yellow-400",
  },
  info: {
    icon: "\u2139", // info sign
    bgClass: "bg-blue-500/10",
    borderClass: "border-blue-500/30",
    textClass: "text-blue-400",
  },
};

export function ToastContainer() {
  const { toasts, removeToast } = useToastStore();

  if (toasts.length === 0) {
    return null;
  }

  return (
    <div className="fixed bottom-4 right-4 z-50 flex flex-col gap-2">
      {toasts.map((toast) => {
        const config = toastConfig[toast.type];
        return (
          <div
            key={toast.id}
            className={`
              flex items-center gap-3 px-4 py-3 rounded-lg border
              shadow-lg backdrop-blur-sm
              animate-in slide-in-from-right-5 fade-in duration-200
              ${config.bgClass} ${config.borderClass}
            `}
            role="alert"
          >
            <span className={`text-lg ${config.textClass}`}>{config.icon}</span>
            <span className="text-sm text-text-primary">{toast.message}</span>
            <button
              onClick={() => removeToast(toast.id)}
              className="ml-2 text-text-tertiary hover:text-text-primary transition-colors"
              aria-label="Dismiss"
            >
              <span className="text-sm">{"\u2715"}</span>
            </button>
          </div>
        );
      })}
    </div>
  );
}
