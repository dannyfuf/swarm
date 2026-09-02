import type { FuzzyFilter, FuzzyMatch } from "./services.ts";

function isBoundary(value: string, index: number): boolean {
  if (index === 0) return true;
  const previous = value[index - 1] ?? "";
  const current = value[index] ?? "";
  return /[/\-_.\s]/.test(previous) || (/[a-z]/.test(previous) && /[A-Z]/.test(current));
}

function match(query: string, value: string): { score: number; positions: number[] } | undefined {
  const needle = query.toLowerCase();
  const haystack = value.toLowerCase();
  const positions: number[] = [];
  let cursor = 0;

  for (const character of needle) {
    const position = haystack.indexOf(character, cursor);
    if (position === -1) return undefined;
    positions.push(position);
    cursor = position + 1;
  }

  let score = 0;
  for (let index = 0; index < positions.length; index += 1) {
    const position = positions[index] ?? 0;
    const previous = positions[index - 1];
    score += 10;
    if (position === 0) score += 18;
    if (isBoundary(value, position)) score += 14;
    if (previous !== undefined) {
      const gap = position - previous - 1;
      score += gap === 0 ? 16 : -gap;
    } else {
      score -= position;
    }
  }

  score -= Math.max(0, value.length - query.length) * 0.05;
  return { score, positions };
}

export const fuzzyFilter: FuzzyFilter = <T>(
  query: string,
  items: T[],
  key: (item: T) => string,
): FuzzyMatch<T>[] => {
  if (query.length === 0) {
    return items.map((item) => ({ item, score: 0, positions: [] }));
  }

  return items
    .map((item, index) => {
      const result = match(query, key(item));
      return result ? { item, index, ...result } : undefined;
    })
    .filter((result): result is FuzzyMatch<T> & { index: number } => result !== undefined)
    .sort((left, right) => right.score - left.score || left.index - right.index)
    .map(({ item, score, positions }) => ({ item, score, positions }));
};
