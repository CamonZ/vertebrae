import { StrictMode, useState, useEffect } from "react";
import { QueryClientProvider } from "@tanstack/react-query";
import { createRoot } from "react-dom/client";
import { RouterProvider } from "react-router-dom";
import "./index.css";
import { router } from "./router";
import { SplashScreen, GlobalListeners } from "./components";
import { DebugConsole } from "./components/DebugConsole";
import { commands } from "./bindings";
import { useDebugLogger } from "./hooks/useDebugLogger";
import { useDebugStore } from "./stores/debugStore";
import { queryClient } from "./query/queryClient";

function App() {
  const [booting, setBooting] = useState(true);
  const [status, setStatus] = useState("Loading configuration...");

  // Subscribe to Rust backend logs for the debug console
  useDebugLogger();

  // Global Cmd+Shift+D to toggle debug console
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (e.metaKey && e.shiftKey && e.code === "KeyD") {
        e.preventDefault();
        useDebugStore.getState().toggleDebugPanel();
      }
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  useEffect(() => {
    async function bootstrap() {
      try {
        setStatus("Loading configuration...");
        await commands.getProjects();
        setStatus("Connecting to backend...");
        await commands.hasProjectSelected();
        setStatus("Ready");
      } catch {
        // Continue to app even if bootstrap checks fail
      }
      // Brief delay so "Ready" is visible
      await new Promise((r) => setTimeout(r, 300));
      setBooting(false);
    }
    bootstrap();
  }, []);

  if (booting) {
    return (
      <>
        <SplashScreen status={status} />
        <DebugConsole />
      </>
    );
  }

  return (
    <>
      <GlobalListeners />
      <RouterProvider router={router} />
      <DebugConsole />
    </>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>
  </StrictMode>
);
