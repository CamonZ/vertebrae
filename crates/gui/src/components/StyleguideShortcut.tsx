import { useEffect } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { useStyleguideStore } from "../stores/styleguideStore";
import { isEditableShortcutTarget } from "../utils/keyboard";
import { isStyleguideShortcut } from "../utils/styleguideShortcut";

export function StyleguideShortcut() {
  const navigate = useNavigate();
  const location = useLocation();

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (!isStyleguideShortcut(event)) return;
      if (event.repeat) return;
      if (isEditableShortcutTarget(event.target)) return;

      event.preventDefault();
      const styleguideStore = useStyleguideStore.getState();
      if (styleguideStore.isStyleguideNavVisible) {
        styleguideStore.hideChromeShortcuts();
        if (location.pathname === "/styleguide") {
          navigate("/operations");
        }
      } else {
        styleguideStore.revealChromeShortcuts();
        navigate("/styleguide");
      }
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [location.pathname, navigate]);

  return null;
}
