export const SETTINGS_TABS = [
  { id: 'general', label: 'General' },
  { id: 'colors', label: 'Colors' },
  { id: 'typography', label: 'Typography' },
  { id: 'footer', label: 'Footer' },
  { id: 'email', label: 'Email' },
] as const;

export type SettingsTabId = (typeof SETTINGS_TABS)[number]['id'];
