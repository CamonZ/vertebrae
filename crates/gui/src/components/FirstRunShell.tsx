import type { ReactNode } from "react";

export interface FirstRunPhase {
  kind: string;
  name: string;
}

interface FirstRunShellProps {
  phases: FirstRunPhase[];
  activeIndex: number;
  title: ReactNode;
  eyebrow: ReactNode;
  lede: ReactNode;
  children: ReactNode;
  footerLeft?: ReactNode;
  footerRight?: ReactNode;
}

function classNames(...values: Array<string | false | null | undefined>) {
  return values.filter(Boolean).join(" ");
}

export function FirstRunShell({
  phases,
  activeIndex,
  title,
  eyebrow,
  lede,
  children,
  footerLeft,
  footerRight,
}: FirstRunShellProps) {
  const total = Math.max(phases.length, 1);
  const progress = `${(Math.min(activeIndex + 1, total) / total) * 100}%`;

  return (
    <main
      className="fr-stage"
      data-testid="first-run-shell"
    >
      <section className="fr-card" aria-label="Project setup wizard">
        <header className="fr-head">
          <div className="fr-wordmark">
            Vertebrae
            <span aria-hidden className="ember" />
          </div>
          <div className="fr-divider" />
          <div className="fr-eyebrow">Project setup</div>
          <div className="fr-head-right">
            <div className="fr-step-count" data-testid="first-run-progress">
              Step <b>{Math.min(activeIndex + 1, total)}</b> of {total}
            </div>
          </div>
        </header>

        <div className="fr-bar" aria-hidden>
          <div className="fr-bar-fill" style={{ width: progress }} />
        </div>

        <div className="fr-body">
          <aside className="fr-spine" data-testid="first-run-spine">
            {phases.map((phase, index) => {
              const done = index < activeIndex;
              const active = index === activeIndex;
              return (
                <div
                  key={`${phase.kind}-${phase.name}`}
                  className={classNames(
                    "fr-phase",
                    done && "done",
                    active && "active"
                  )}
                  aria-current={active ? "step" : undefined}
                >
                  <span className="fr-pnum">{index + 1}</span>
                  <span className="fr-pmeta">
                    <span className="fr-pkind">{phase.kind}</span>
                    <span className="fr-pname">{phase.name}</span>
                  </span>
                </div>
              );
            })}
          </aside>

          <div className="fr-content">
            <div className="fr-c-head">
              <div className="key">{eyebrow}</div>
              <h1>{title}</h1>
              <p className="lede">{lede}</p>
            </div>
            <div className="fr-scroll">{children}</div>
          </div>
        </div>

        <footer className="fr-foot">
          <div className="note">{footerLeft}</div>
          {footerRight && <div className="sp">{footerRight}</div>}
        </footer>
      </section>
    </main>
  );
}
