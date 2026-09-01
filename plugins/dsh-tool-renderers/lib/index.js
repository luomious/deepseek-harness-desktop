// Host half of the dsh-tool-renderers plugin.
//
// The feature lives in the browser half (lib/client.js): it registers keyed
// tool.call.toolview renderers for DSH-specific tools (goal/jobs/subagent) so
// their conversation rows show a compact summary card instead of the generic
// fallback. Nothing is needed on the host, but the loader expects a host entry.

export const name = '@dsh-external/dsh-tool-renderers'
export const inject = []

export function apply() {
  // Pure client-side feature; nothing to host.
}
