function App() {
  return (
    <div className="min-h-screen bg-bg-secondary">
      <header className="bg-bg-primary border-b border-border px-6 py-4">
        <h1 className="text-2xl font-bold text-text-primary">Vertebrae</h1>
        <p className="text-sm text-text-secondary">Task Management</p>
      </header>

      <main className="p-6">
        <div className="rounded-lg bg-bg-primary p-6 shadow-md">
          <h2 className="mb-4 text-xl font-semibold text-text-primary">
            Welcome to Vertebrae
          </h2>
          <p className="mb-4 text-text-secondary">
            Your task management application is ready. This frontend is built
            with:
          </p>
          <ul className="list-inside list-disc space-y-2 text-text-secondary">
            <li>
              <span className="font-medium text-primary">React 19</span> with
              concurrent features
            </li>
            <li>
              <span className="font-medium text-primary">Tailwind CSS 4</span>{" "}
              with CSS-first configuration
            </li>
            <li>
              <span className="font-medium text-primary">Vite</span> for fast
              development builds
            </li>
            <li>
              <span className="font-medium text-primary">TypeScript</span> for
              type safety
            </li>
          </ul>

          <div className="mt-6">
            <button
              type="button"
              className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-primary-hover focus:outline-none focus:ring-2 focus:ring-border-focus focus:ring-offset-2"
            >
              Get Started
            </button>
          </div>
        </div>
      </main>
    </div>
  );
}

export default App;
