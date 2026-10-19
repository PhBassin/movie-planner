// Pre-paint Member Appearance (see CONTEXT.md → Appearance).
// Loaded as a blocking classic script in <head> (an external file, because
// the CSP forbids inline scripts) so a Member who chose dark never sees a
// light flash on reload. The server stays the source of truth: useAppearance
// re-applies the persisted choice once GET /api/me answers.
// The storage key MUST match APPEARANCE_STORAGE_KEY in src/utils/appearance.ts.
try {
  if (localStorage.getItem('appearance') === 'dark') {
    document.documentElement.classList.add('dark');
  }
} catch {
  // Storage unavailable: fall back to the light surface until /api/me answers.
}
