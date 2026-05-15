/** ANSI-colored progress bar: green → yellow → red as ratio increases. */
export function progressBar(current: number, max: number, width = 25): string {
  const ratio = Math.min(current / max, 1);
  const filled = Math.round(ratio * width);
  const empty = width - filled;
  const pct = Math.round(ratio * 100);

  // Color gradient based on percentage
  let color: string;
  if (ratio < 0.5) color = "\x1b[92m";       // bright green
  else if (ratio < 0.75) color = "\x1b[93m";  // bright yellow
  else color = "\x1b[91m";                    // bright red

  const reset = "\x1b[0m";
  return `${color}${"█".repeat(filled)}${"░".repeat(empty)}${reset} ${pct}%`;
}
