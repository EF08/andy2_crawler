export function squeezeWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

export function trimToLimit(value: string, limit: number): string {
  if (value.length <= limit) {
    return value;
  }
  return `${value.slice(0, Math.max(0, limit - 3))}...`;
}

export function uniqStrings(values: string[]): string[] {
  return Array.from(new Set(values.map((x) => squeezeWhitespace(x)).filter(Boolean)));
}

export function canonicalizeUrl(raw: string): string {
  try {
    const url = new URL(raw);
    url.hash = "";
    url.searchParams.sort();
    return url.toString();
  } catch {
    return raw;
  }
}
