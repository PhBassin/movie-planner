import type { Appearance } from '../api/me.js';

/**
 * Device-local memory of the Member's last known Appearance (see CONTEXT.md
 * → Appearance). The server (`member_preferences`) stays the source of truth;
 * this copy only lets `public/appearance-init.js` paint the right surface
 * before React boots, avoiding a light flash on reload. The key MUST match
 * the one read by that pre-paint script.
 */
export const APPEARANCE_STORAGE_KEY = 'appearance';

/** Apply a Member's Appearance to the document root and remember it locally. */
export function applyMemberAppearance(appearance: Appearance): void {
  document.documentElement.classList.toggle('dark', appearance === 'dark');
  try {
    localStorage.setItem(APPEARANCE_STORAGE_KEY, appearance);
  } catch {
    // Storage unavailable (private mode, quota): the server copy still rules.
  }
}

/** No Member Appearance (Visitor, Staff, logged out): default surface, forget the local copy. */
export function clearMemberAppearance(): void {
  document.documentElement.classList.remove('dark');
  try {
    localStorage.removeItem(APPEARANCE_STORAGE_KEY);
  } catch {
    // Storage unavailable: nothing to forget.
  }
}
