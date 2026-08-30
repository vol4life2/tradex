// Shared constants/types for the dashboard's account/status filters — the
// selects live in TopBar (so they're visible in the header), the filtering
// itself happens in Dashboard, and the state lives in App — all three need
// these without creating an import cycle through any single component.
export const ALL_ACCOUNTS = 'all';
export const NO_ACCOUNT = '(no account)';
export type StatusFilter = 'all' | 'open' | 'closed';
