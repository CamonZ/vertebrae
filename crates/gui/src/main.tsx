import { StrictMode, useState, useEffect } from "react";
import { QueryClientProvider } from "@tanstack/react-query";
import { createRoot } from "react-dom/client";
import { RouterProvider } from "react-router-dom";
import "./index.css";
import { router } from "./router";
import { SplashScreen, GlobalListeners } from "./components";
import { commands } from "./bindings";
import { queryClient } from "./query/queryClient";
import {
  checkGuiUpdateChannels,
  checkLocalBackendUpdate,
  createGuiUpdateScheduler,
} from "./update";
import { installActionableReferenceClickRecovery } from "./utils/actionableReferenceClickRecovery";

function App() {
  const [booting, setBooting] = useState(true);
  const [status, setStatus] = useState("Loading configuration...");
  const [updateScheduler] = useState(() =>
    createGuiUpdateScheduler({
      checkChannels: checkGuiUpdateChannels,
      checkLocalBackend: checkLocalBackendUpdate,
    })
  );

  useEffect(() => installActionableReferenceClickRecovery(), []);

  useEffect(() => {
    updateScheduler.start();
    return () => updateScheduler.stop();
  }, [updateScheduler]);

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
      </>
    );
  }

  return (
    <>
      <GlobalListeners />
      <RouterProvider router={router} />
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
