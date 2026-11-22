import { useState, useSyncExternalStore } from "react";
import {
  hasFailedCatalogSave,
  retryCatalogSave,
  subscribeToCatalogSaves,
} from "../../utils/localChatPersistence";

export function CatalogSaveWarning({
  sessionId,
  announce = false,
}: {
  sessionId: string;
  announce?: boolean;
}) {
  const failed = useSyncExternalStore(subscribeToCatalogSaves, () =>
    hasFailedCatalogSave(sessionId)
  );
  const [retrying, setRetrying] = useState(false);

  return (
    <>
      {announce && (
        <span role="status" className="sr-only">
          {failed ? "Chat catalog save failed. Retry before closing." : ""}
        </span>
      )}
      {failed && (
        <button
          type="button"
          className="ctl ctl-quiet hc-catalog-save-warning"
          title="Vertebrae could not save this chat to its catalog. Retry before closing."
          aria-label={retrying ? "Retrying chat catalog save" : "Chat catalog save failed. Retry save"}
          disabled={retrying}
          onClick={async () => {
            setRetrying(true);
            try {
              await retryCatalogSave(sessionId);
            } finally {
              setRetrying(false);
            }
          }}
        >
          <span aria-hidden="true">⚠</span>
        </button>
      )}
    </>
  );
}
