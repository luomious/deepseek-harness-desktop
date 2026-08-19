// Host half of the dsh-model-whitelist plugin.
//
// The feature lives in the browser half (lib/client.js): a Settings panel
// ("模型管理") to pick which models show in the conversation model picker, and a
// client-side filter over api.sessions.models. Nothing is needed on the host,
// but the loader expects a host entry to exist.

export const name = '@dsh-external/dsh-model-whitelist';
export const inject = [];

export function apply() {
  // Pure client-side feature; nothing to host.
}
