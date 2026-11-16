import { useCallback, useEffect, useState, type ReactNode, type RefObject } from "react";

export interface SettingsNavItem<Section extends string> {
  section: Section;
  label: string;
  testId: string;
  /** Trailing adornment, e.g. an update badge. */
  trailing?: ReactNode;
}

export interface SettingsNavGroup<Section extends string> {
  label: string;
  items: SettingsNavItem<Section>[];
}

interface Anchor {
  id: string;
  label: string;
  depth: number;
}

const ANCHOR_SELECTOR = "[data-settings-anchor]";
/** Distance from the pane top at which a heading counts as "being read". */
const SPY_OFFSET = 96;

function slug(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");
}

/**
 * Collect the current page's section headings (elements tagged with
 * `data-settings-anchor`) and track which one is being read. Rescans when
 * the page changes and when content loads in late.
 */
function useSettingsAnchors(
  container: RefObject<HTMLElement | null>,
  pageKey: string
) {
  const [anchors, setAnchors] = useState<Anchor[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);

  useEffect(() => {
    const root = container.current;
    if (!root) return;
    const scan = () => {
      const seen = new Set<string>();
      const next: Anchor[] = [];
      root.querySelectorAll<HTMLElement>(ANCHOR_SELECTOR).forEach((element) => {
        // A bare `data-settings-anchor` renders as "true": use the heading text.
        const explicit = element.dataset.settingsAnchor;
        const label = (
          explicit && explicit !== "true" ? explicit : element.textContent ?? ""
        ).trim();
        if (!label) return;
        let id = element.id || `settings-${pageKey}-${slug(label)}`;
        while (seen.has(id)) id = `${id}-x`;
        seen.add(id);
        if (!element.id) element.id = id;
        next.push({
          id,
          label,
          depth: Number(element.dataset.settingsAnchorDepth ?? 1),
        });
      });
      setAnchors((current) =>
        current.length === next.length &&
        current.every(
          (anchor, index) =>
            anchor.id === next[index].id && anchor.label === next[index].label
        )
          ? current
          : next
      );
    };
    scan();
    const observer = new MutationObserver(scan);
    observer.observe(root, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, [container, pageKey]);

  useEffect(() => {
    const root = container.current;
    if (!root || anchors.length === 0) {
      setActiveId(null);
      return;
    }
    const onScroll = () => {
      const top = root.getBoundingClientRect().top + SPY_OFFSET;
      let current: string | null = anchors[0]?.id ?? null;
      for (const anchor of anchors) {
        const element = document.getElementById(anchor.id);
        if (element && element.getBoundingClientRect().top <= top) {
          current = anchor.id;
        }
      }
      setActiveId(current);
    };
    onScroll();
    root.addEventListener("scroll", onScroll, { passive: true });
    return () => root.removeEventListener("scroll", onScroll);
  }, [anchors, container]);

  const scrollTo = useCallback(
    (id: string) => {
      document
        .getElementById(id)
        ?.scrollIntoView?.({ block: "start", behavior: "smooth" });
      setActiveId(id);
    },
    []
  );

  return { anchors, activeId, scrollTo };
}

/**
 * Settings navigation as a two-level tree: pages grouped under General,
 * Models and System, with the current page expanded to its sections. A
 * section click scrolls the content pane; the section being read is marked.
 */
export function SettingsNavTree<Section extends string>({
  groups,
  activeSection,
  onSelect,
  contentRef,
}: {
  groups: SettingsNavGroup<Section>[];
  activeSection: Section;
  onSelect: (section: Section) => void;
  contentRef: RefObject<HTMLElement | null>;
}) {
  const { anchors, activeId, scrollTo } = useSettingsAnchors(
    contentRef,
    activeSection
  );

  return (
    <nav className="settings-tree" aria-label="Settings">
      {groups.map((group) => (
        <div key={group.label} className="settings-tree-group">
          <p className="settings-tree-group-label">{group.label}</p>
          <ul role="list">
            {group.items.map((item) => {
              const current = item.section === activeSection;
              return (
                <li key={item.section}>
                  <button
                    type="button"
                    onClick={() => onSelect(item.section)}
                    className="split-nav-item flex items-center justify-between gap-2"
                    aria-current={current ? "page" : undefined}
                    aria-expanded={
                      current && anchors.length > 1 ? true : undefined
                    }
                    data-testid={item.testId}
                  >
                    <span>{item.label}</span>
                    {item.trailing}
                  </button>
                  {current && anchors.length > 1 && (
                    <ul
                      role="list"
                      className="settings-tree-sections"
                      aria-label={`${item.label} sections`}
                    >
                      {anchors.map((anchor) => (
                        <li key={anchor.id}>
                          <button
                            type="button"
                            className="settings-tree-section"
                            data-depth={anchor.depth}
                            aria-current={
                              anchor.id === activeId ? "location" : undefined
                            }
                            onClick={() => scrollTo(anchor.id)}
                          >
                            {anchor.label}
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </nav>
  );
}
