export function formatErr(err: unknown): string {
  if (err instanceof Error) {
    return `${err.name}: ${err.message}`;
  }
  if (typeof err === 'string') return err;
  try {
    const s = JSON.stringify(err);
    return s === '{}' ? String(err) : s;
  } catch {
    return String(err);
  }
}
