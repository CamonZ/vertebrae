import { StrictMode, useState, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { RouterProvider } from "react-router-dom";
import "./index.css";
import { router } from "./router";
import { SplashScreen } from "./components";
import { commands } from "./bindings";

function App() {
  const [booting, setBooting] = useState(true);
  const [status, setStatus] = useState("Loading configuration...");

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
    return <SplashScreen status={status} />;
  }

  return <RouterProvider router={router} />;
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>
);
