// Host half of the dsh-session-history plugin.
//
// The whole feature lives in the browser half (lib/client.js): a history
// button in the composer tool row opens a popup listing past sessions, and
// clicking a row jumps to that session. Nothing is needed on the host, but
// the loader expects a host entry to exist.

export const name = '@dsh-external/dsh-session-history';
export const inject = [];

export function apply() {
  // Pure client-side feature; nothing to host.
}
