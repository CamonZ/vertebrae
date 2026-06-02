interface SplashScreenProps {
  status?: string;
}

export function SplashScreen({ status = "Loading..." }: SplashScreenProps) {
  return (
    <div className="flex h-screen w-screen flex-col items-center justify-center bg-bg-1">
      <h1 className="mb-1 text-4xl font-bold text-accent">Vertebrae</h1>
      <p className="mb-8 text-lg text-fg-soft">Agent Orchestrator</p>
      <div className="mb-4 h-8 w-8 animate-spin rounded-full border-2 border-border border-t-accent" />
      <p className="text-sm text-fg-mute">{status}</p>
    </div>
  );
}
