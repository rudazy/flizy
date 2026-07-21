export function StepList({
  steps,
}: {
  steps: Array<{ n: string; title: string; body: string }>;
}) {
  return (
    <ol className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
      {steps.map((s) => (
        <li key={s.n} className="card relative overflow-hidden p-6">
          <span className="font-sans text-3xl font-semibold tracking-wide text-lime/90">{s.n}</span>
          <h3 className="mt-3 font-sans text-base tracking-wide text-paper">{s.title}</h3>
          <p className="mt-2 text-sm leading-relaxed text-muted">{s.body}</p>
        </li>
      ))}
    </ol>
  );
}
