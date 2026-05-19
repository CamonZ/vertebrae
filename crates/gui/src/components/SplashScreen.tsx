interface SplashScreenProps {
  status?: string;
}

export function SplashScreen({ status = "Loading..." }: SplashScreenProps) {
  return (
    <div className="flex h-screen w-screen flex-col items-center justify-center bg-bg-secondary">
      <h1 className="mb-1 text-2xl font-bold text-primary">Vertebrae</h1>
      <p className="mb-8 text-lg text-text-secondary">Agent Orchestrator</p>
      <div className="mb-4 h-8 w-8 animate-spin rounded-full border-2 border-border border-t-primary" />
      <p className="text-sm text-text-tertiary">{status}</p>
    </div>
  );
}
