/** Format a number of seconds as a timecode: `m:ss` or `h:mm:ss`. */
export function formatTimecode(sec: number): string {
  const total = isFinite(sec) && sec > 0 ? Math.floor(sec) : 0;
  const s = total % 60;
  const m = Math.floor(total / 60) % 60;
  const h = Math.floor(total / 3600);
  const mm = String(m).padStart(2, "0");
  const ss = String(s).padStart(2, "0");
  return h > 0 ? `${h}:${mm}:${ss}` : `${m}:${ss}`;
}
