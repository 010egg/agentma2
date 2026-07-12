import type { RegisteredTool } from '../simulator/types';

const TOOL_CATEGORIES_STORAGE_KEY = 'agentma_tool_categories';

function uniqueCategoryNames(values: unknown[]): string[] {
  const seen = new Set<string>();
  const categories: string[] = [];

  for (const value of values) {
    if (typeof value !== 'string') continue;
    const name = value.trim();
    const key = name.toLocaleLowerCase();
    if (!name || seen.has(key)) continue;
    seen.add(key);
    categories.push(name);
  }

  return categories;
}

export function initToolCategories(tools: RegisteredTool[]): string[] {
  const derived = uniqueCategoryNames(tools.map(tool => tool.category));
  let stored: string[] = [];

  try {
    const raw = localStorage.getItem(TOOL_CATEGORIES_STORAGE_KEY);
    if (raw) {
      const parsed: unknown = JSON.parse(raw);
      if (Array.isArray(parsed)) stored = uniqueCategoryNames(parsed);
    }
  } catch {
    // Corrupt or unavailable local storage should not block the catalog.
  }

  const merged = uniqueCategoryNames([...stored, ...derived]);
  saveToolCategories(merged);
  return merged;
}

export function saveToolCategories(categories: string[]) {
  try {
    localStorage.setItem(TOOL_CATEGORIES_STORAGE_KEY, JSON.stringify(uniqueCategoryNames(categories)));
  } catch {
    // Keep the current in-memory state when storage is unavailable.
  }
}
