// Host half of the dsh-model-picker-group plugin.
//
// The feature lives in the browser half (lib/client.js): it wraps
// api.sessions.models and reorders the provider groups so every
// "(modlens vision)" group sits directly below its upstream provider group.
// Nothing is needed on the host, but the loader expects a host entry to exist.

export const name = '@dsh-external/dsh-model-picker-group'
export const inject = []

export function apply() {
  // Pure client-side feature; nothing to host.
}
