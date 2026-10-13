// Remembers (per browser) that the drag-to-edit demo has been shown, so it only autoplays once.
const HINT_KEY = 'billcmp.dragHintSeen';

export function dragHintSeen(): boolean {
  try {
    return localStorage.getItem(HINT_KEY) === '1';
  } catch {
    return true; // storage blocked: don't nag on every load
  }
}

export function markDragHintSeen(): void {
  try {
    localStorage.setItem(HINT_KEY, '1');
  } catch {
    /* best-effort */
  }
}
