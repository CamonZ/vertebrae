import { useState } from "react";
import {
  Badge,
  Button,
  Chip,
  Divider,
  Icon,
  Input,
  Select,
  Skeleton,
  Spinner,
  Text,
  Textarea,
  Toggle,
  Tooltip,
} from "./atoms";
import {
  Card,
  ChatMessage,
  EmptyState,
  FilterBar,
  Modal,
  Panel,
  SearchInput,
  SectionGroup,
  StatusBadge,
  ToolCallBlock,
  TreeNode,
} from "./molecules";
import {
  ContextMeter,
  PanelHeader,
  ReviewGateBanner,
} from "./panels";
import { stepTypeStyle } from "./WorkflowPipeline/stepTypeStyling";
import {
  LiveExecutionBanner,
  NodeActionPopover,
} from "./WorkflowPipeline/overlays";

const SURFACE_TOKENS = [
  { name: "bg", hex: "#131318" },
  { name: "bg-1", hex: "#19191F" },
  { name: "bg-2", hex: "#21212A" },
  { name: "bg-3", hex: "#2B2B34" },
  { name: "bg-4", hex: "#36363F" },
];

const TEXT_TOKENS = [
  { name: "fg", hex: "#E8E5DD" },
  { name: "fg-soft", hex: "#CCC8C0" },
  { name: "fg-mute", hex: "#9C988E" },
  { name: "fg-faint", hex: "#645F57" },
  { name: "fg-ghost", hex: "#45413C" },
];

const STATUS_TOKENS = [
  { token: "--color-ok", label: "ok / success" },
  { token: "--color-warn", label: "warn" },
  { token: "--color-err", label: "err" },
  { token: "--color-info", label: "info" },
];

const STEP_KINDS = [
  "execute",
  "evaluate",
  "route",
  "human_input",
  "wait_children",
] as const;

function Plate({
  number,
  title,
  description,
  children,
}: {
  number: string;
  title: string;
  description: string;
  children: React.ReactNode;
}) {
  return (
    <section className="mt-12 grid grid-cols-1 gap-8 border-t border-[var(--color-accent)] pt-8 md:grid-cols-[220px_1fr]">
      <header className="md:sticky md:top-6">
        <div className="plate-num">
          Plate <span className="n">{number}</span>
        </div>
        <h2 className="mt-2 font-serif text-3xl text-[var(--color-fg)]">
          {title}
        </h2>
        <p className="mt-2 font-serif italic text-[15px] leading-relaxed text-[var(--color-fg-mute)]">
          {description}
        </p>
      </header>
      <div className="space-y-6">{children}</div>
    </section>
  );
}

function ColorChip({ name, hex }: { name: string; hex: string }) {
  return (
    <div className="flex items-center gap-3 rounded-[var(--radius-md)] border border-[var(--color-line)] bg-[var(--color-bg-1)] px-3 py-2">
      <span
        className="h-6 w-6 shrink-0 rounded-[var(--radius-sm)] border border-[var(--color-line-strong)]"
        style={{ backgroundColor: hex }}
      />
      <div className="flex flex-col">
        <span className="font-mono text-xs text-[var(--color-fg)]">{name}</span>
        <span className="font-mono text-2xs text-[var(--color-fg-mute)]">
          {hex}
        </span>
      </div>
    </div>
  );
}

function StepTypePlate({ kind }: { kind: (typeof STEP_KINDS)[number] }) {
  const style = stepTypeStyle(kind);
  return (
    <div
      className="relative overflow-hidden rounded-[var(--radius-md)] border border-[var(--color-line-strong)] bg-[var(--color-bg-1)] p-4"
      style={{
        backgroundColor: `color-mix(in oklch, var(${style.washVar}) 18%, var(--color-bg-1))`,
      }}
    >
      <span
        aria-hidden
        className="absolute left-0 right-0 top-0 h-[3px]"
        style={{ backgroundColor: `var(${style.barVar})` }}
      />
      <div
        className="font-mono text-2xs uppercase tracking-[0.14em]"
        style={{ color: `var(${style.fgVar})` }}
      >
        {style.kind}
      </div>
      <div className="mt-1 flex items-baseline justify-between">
        <h3
          className="font-serif text-xl"
          style={{ color: `var(${style.fgVar})` }}
        >
          {style.label}
        </h3>
        <span
          className="text-base"
          style={{ color: `var(${style.fgVar})` }}
          aria-hidden
        >
          {style.icon}
        </span>
      </div>
      <div className="mt-2 font-mono text-2xs text-[var(--color-fg-mute)]">
        bar · wash · fg
      </div>
    </div>
  );
}

/**
 * Hearth design system showcase. Renders a representative sample of every
 * token, atom, molecule, panel, and canvas overlay so the styleguide page
 * doubles as a living reference + smoke surface for the visual language.
 */
export function HearthShowcase() {
  const [filterActive, setFilterActive] = useState(false);
  const [toggleOn, setToggleOn] = useState(true);
  const [modalOpen, setModalOpen] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [panelOpen, setPanelOpen] = useState(false);
  const [section, setSection] = useState(true);
  const [search, setSearch] = useState("jwt");

  return (
    <div className="space-y-2">
      <header>
        <div className="font-mono text-eyebrow uppercase tracking-[0.16em] text-[var(--color-accent)]">
          Hearth · Design System
        </div>
        <h1 className="mt-2 font-serif text-5xl leading-none text-[var(--color-fg)]">
          A warm dark identity for AI orchestration.
        </h1>
        <p className="mt-3 max-w-[60ch] font-serif italic text-[22px] leading-snug text-[var(--color-fg-soft)]">
          Copper firelight on cool charcoal; serif Newsreader for moments,
          Geist for body, JetBrains Mono for code and ids.
        </p>
      </header>

      <Plate
        number="I"
        title="Foundations"
        description="Surfaces step in equal value-shifts; text drifts from cream to ghost. Status reserves chroma for meaning."
      >
        <div>
          <div className="font-mono text-2xs uppercase tracking-[0.14em] text-[var(--color-fg-mute)]">
            Surfaces
          </div>
          <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-5">
            {SURFACE_TOKENS.map((c) => (
              <ColorChip key={c.name} {...c} />
            ))}
          </div>
        </div>
        <div>
          <div className="font-mono text-2xs uppercase tracking-[0.14em] text-[var(--color-fg-mute)]">
            Text
          </div>
          <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-5">
            {TEXT_TOKENS.map((c) => (
              <ColorChip key={c.name} {...c} />
            ))}
          </div>
        </div>
        <div>
          <div className="font-mono text-2xs uppercase tracking-[0.14em] text-[var(--color-fg-mute)]">
            Status
          </div>
          <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-4">
            {STATUS_TOKENS.map((s) => (
              <div
                key={s.token}
                className="rounded-[var(--radius-md)] border border-[var(--color-line)] bg-[var(--color-bg-1)] px-3 py-3"
              >
                <span
                  className="block h-1 w-full rounded-full"
                  style={{ backgroundColor: `var(${s.token})` }}
                />
                <div className="mt-2 font-mono text-2xs text-[var(--color-fg-mute)]">
                  {s.label}
                </div>
                <div className="mt-1 font-mono text-2xs text-[var(--color-fg-faint)]">
                  {s.token}
                </div>
              </div>
            ))}
          </div>
        </div>
      </Plate>

      <Plate
        number="II"
        title="Step types"
        description="Five workflow kinds, each with a bar, wash, and foreground. The vocabulary repeats across the DAG, the board, and the operations rows."
      >
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-5">
          {STEP_KINDS.map((k) => (
            <StepTypePlate key={k} kind={k} />
          ))}
        </div>
      </Plate>

      <Plate
        number="III"
        title="Atoms"
        description="Indivisible primitives — variants, sizes, states. Everything else composes from these."
      >
        <Card header="Buttons">
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="primary">Run</Button>
            <Button variant="secondary">Cancel</Button>
            <Button variant="ghost">Ghost</Button>
            <Button variant="danger" confirm>
              Delete…
            </Button>
            <Button variant="primary" size="sm">
              sm
            </Button>
            <Button variant="primary" size="lg">
              lg
            </Button>
            <Button variant="primary" loading>
              Saving
            </Button>
          </div>
        </Card>
        <Card header="Inputs">
          <div className="grid gap-3 sm:grid-cols-2">
            <Input placeholder="Title" />
            <Input placeholder="Invalid" invalid />
            <Select
              options={[
                { value: "ai", label: "AI" },
                { value: "human", label: "Human review" },
                { value: "wait", label: "Wait for children" },
              ]}
              defaultValue="ai"
              aria-label="step kind"
            />
            <Textarea placeholder="Description" maxRows={4} />
          </div>
        </Card>
        <Card header="Badges & Chips">
          <div className="flex flex-wrap items-center gap-2">
            <Badge intent="success" dot>
              Done
            </Badge>
            <Badge intent="warning" dot>
              Waiting
            </Badge>
            <Badge intent="error" dot>
              Failed
            </Badge>
            <Badge intent="info" dot>
              Running
            </Badge>
            <Badge intent="neutral">workflow / step</Badge>
            <Badge count={3} intent="error" />
            <Chip variant="static">tag</Chip>
            <Chip
              variant="filter"
              active={filterActive}
              onClick={() => setFilterActive((v) => !v)}
            >
              Filter
            </Chip>
            <Chip variant="input" onDismiss={() => undefined}>
              level: ticket
            </Chip>
          </div>
        </Card>
        <Card header="Other atoms">
          <div className="flex flex-wrap items-center gap-3 text-sm">
            <Spinner className="h-4 w-4 text-[var(--color-accent)]" />
            <Toggle
              checked={toggleOn}
              onChange={setToggleOn}
              label="Notifications"
            />
            <Tooltip label="Hover delay 400ms" placement="top">
              <span className="inline-block rounded-[var(--radius-sm)] border border-dashed border-[var(--color-line-strong)] px-2 py-1 text-xs text-[var(--color-fg-mute)]">
                hover me
              </span>
            </Tooltip>
            <Divider orientation="vertical" />
            <Icon label="info">
              <circle cx="12" cy="12" r="9" />
              <path d="M12 8h.01M11 12h1v4h1" />
            </Icon>
            <Skeleton variant="text" width={120} />
            <Skeleton variant="circle" width={24} height={24} />
          </div>
          <Divider label="OR" className="mt-4" />
        </Card>
        <Card header="Typography">
          <div className="space-y-2">
            <Text variant="display">Hearth</Text>
            <Text variant="heading-xl">Heading XL</Text>
            <Text variant="heading-lg">Heading LG</Text>
            <Text variant="heading-md">Heading MD</Text>
            <Text variant="lede" color="secondary">
              Lede paragraph in serif italic — used for one-line subtitles.
            </Text>
            <Text variant="body">
              Body text in Geist. The quick brown fox jumps over the lazy dog.
            </Text>
            <Text variant="eyebrow">Eyebrow · mono · uppercase</Text>
            <Text variant="mono" color="tertiary">
              const x = "monospace text in JetBrains Mono";
            </Text>
          </div>
        </Card>
      </Plate>

      <Plate
        number="IV"
        title="Molecules"
        description="Composed primitives — search, panels, filters, list rows, and the canonical task status."
      >
        <Card header="Search + Filter bar">
          <FilterBar
            search={
              <SearchInput
                aria-label="Search tasks"
                placeholder="Search tasks…"
                value={search}
                onChange={setSearch}
              />
            }
            filters={
              <>
                <Chip
                  variant="filter"
                  active
                  onClick={() => undefined}
                >
                  Epic
                </Chip>
                <Chip variant="filter" onClick={() => undefined}>
                  Ticket
                </Chip>
                <Chip variant="filter" onClick={() => undefined}>
                  Task
                </Chip>
              </>
            }
            active={[
              { id: "lv", label: "Level: Epic", onClear: () => undefined },
            ]}
            onClearAll={() => undefined}
          />
        </Card>
        <Card header="Status badges">
          <div className="flex flex-wrap items-center gap-2">
            <StatusBadge state="queued" />
            <StatusBadge state="executing" />
            <StatusBadge state="waiting" />
            <StatusBadge state="completed" />
            <StatusBadge state="failed" />
            <StatusBadge state="pending_review" />
            <StatusBadge
              state={{
                kind: "workflow",
                workflow: "Implementation",
                step: "In Progress",
              }}
            />
          </div>
        </Card>
        <Card header="Tree nodes">
          <div className="overflow-hidden rounded-[var(--radius-md)] border border-[var(--color-line)] bg-[var(--color-bg-1)]">
            <TreeNode hasChildren expanded depth={0} icon="◈">
              Refactor authentication system
            </TreeNode>
            <TreeNode hasChildren expanded depth={1} icon="◇">
              Implement JWT service
            </TreeNode>
            <TreeNode depth={2} icon="·" right="m3n4o5p6">
              Create token signing function
            </TreeNode>
            <TreeNode
              depth={2}
              icon="·"
              right="q7r8s9t0"
              selected
            >
              Write JWT validation tests
            </TreeNode>
          </div>
        </Card>
        <Card header="Sections">
          <SectionGroup
            label="Acceptance Criteria"
            count={3}
            open={section}
            onOpenChange={setSection}
          >
            <ul className="space-y-2 text-sm text-[var(--color-fg-soft)]">
              <li>✓ JWT tokens must expire in 24h</li>
              <li>✓ Refresh token flow implemented</li>
              <li>○ Unit tests for token validation</li>
            </ul>
          </SectionGroup>
          <SectionGroup label="Code References" count={2} />
        </Card>
        <Card header="Chat surface">
          <div className="flex flex-col gap-3">
            <ChatMessage role="user" author="You">
              Implement a JWT signing service for the auth middleware.
            </ChatMessage>
            <ChatMessage role="assistant" author="Claude · sonnet">
              I'll start by reading the existing middleware code.
              <ToolCallBlock
                toolName="Read"
                summary="src/auth/middleware.rs"
                result="// existing middleware…"
                defaultOpen
              />
              Now I'll draft a new JwtSigner service…
            </ChatMessage>
            <ChatMessage role="system">
              streaming · context approaching limit
            </ChatMessage>
          </div>
        </Card>
        <Card header="Empty / modal / panel">
          <div className="grid gap-3 sm:grid-cols-2">
            <EmptyState
              title="All clear"
              description="No tasks need attention."
              action={<Button variant="secondary">Refresh</Button>}
            />
            <div className="space-y-2">
              <Button variant="secondary" onClick={() => setModalOpen(true)}>
                Open dialog modal
              </Button>
              <Button variant="danger" onClick={() => setConfirmOpen(true)}>
                Open confirm modal…
              </Button>
              <Button variant="secondary" onClick={() => setPanelOpen(true)}>
                Open side panel
              </Button>
            </div>
          </div>
          <Modal
            open={modalOpen}
            onClose={() => setModalOpen(false)}
            title="Edit Step"
          >
            <p className="text-sm text-[var(--color-fg-soft)]">
              Dialog body content — focus-trapped and Escape-closable.
            </p>
          </Modal>
          <Modal
            open={confirmOpen}
            onClose={() => setConfirmOpen(false)}
            variant="confirm"
            title="Delete task?"
            description="This will permanently remove the task and its subtree."
            confirmIntent="danger"
            confirmLabel="Delete"
            onConfirm={() => setConfirmOpen(false)}
          />
          <Panel
            open={panelOpen}
            onClose={() => setPanelOpen(false)}
            title="Implement JWT service"
            onDetach={() => setPanelOpen(false)}
            footer={
              <div className="flex items-center gap-2">
                <Button variant="ghost">Open Chat</Button>
                <Button variant="primary">Run</Button>
              </div>
            }
          >
            <PanelHeader
              title={<Text variant="heading-md">Implement JWT service</Text>}
              metadata={
                <>
                  <span className="font-mono text-xs">i9j0k1l2</span>
                  <span aria-hidden>·</span>
                  <StatusBadge state="executing" />
                </>
              }
            />
            <div className="p-4 text-sm text-[var(--color-fg-soft)]">
              Panel body. Use SectionGroups to lay out detail sections.
            </div>
          </Panel>
        </Card>
      </Plate>

      <Plate
        number="V"
        title="Panels"
        description="Standard shells for detail surfaces — header, review gate, and context meter."
      >
        <Card header="Review gate">
          <ReviewGateBanner
            title="Run 3 needs your review"
            description="The agent finished the implementation step and requests approval before merging."
            onAccept={() => undefined}
            onReject={() => undefined}
          />
        </Card>
        <Card header="Context meter">
          <div className="space-y-3">
            <ContextMeter used={20_000} max={200_000} />
            <ContextMeter used={150_000} max={200_000} />
            <ContextMeter used={195_000} max={200_000} />
          </div>
        </Card>
      </Plate>

      <Plate
        number="VI"
        title="Canvas overlays"
        description="Pipeline-only surfaces that float on top of the DAG canvas."
      >
        <Card header="NodeActionPopover">
          <div className="flex flex-wrap items-start gap-4">
            <NodeActionPopover
              isRunning={false}
              summary={{ completed: 14, failed: 1, running: 0 }}
              onPrimary={() => undefined}
            />
            <NodeActionPopover
              isRunning
              elapsed="0:47"
              onStop={() => undefined}
            />
          </div>
        </Card>
        <Card header="LiveExecutionBanner">
          <LiveExecutionBanner
            totalRunning={3}
            steps={[
              { id: "ip", name: "In Progress", count: 2 },
              { id: "rg", name: "Review Gate", count: 1 },
            ]}
            onStepClick={() => undefined}
          />
        </Card>
      </Plate>
    </div>
  );
}
