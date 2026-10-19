/**
 * A programme label: the programme's own colour as a dot, the name in text colour.
 * Programme colours are user-chosen, so they never carry text (no contrast guarantee).
 */
export function ProgramChip({ name, color, className = '' }: { name: string; color?: string | null; className?: string }) {
  return (
    <span className={`program-chip ${className}`}>
      <span className="program-chip-dot" style={{ background: color ?? 'var(--text-subtle)' }} aria-hidden="true" />
      {name}
    </span>
  );
}
