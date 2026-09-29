window.__ModuleLoader__.load({
	id: "@dsh-external/dsh-settings-scope-shim",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		function createMemoryScope(mode) {
			const listeners = new Set();
			const snapshot = {
				status: mode === "host" ? "ready" : "unavailable",
				value: void 0,
				base: void 0,
				user: void 0,
				revision: 0,
				writable: mode === "host",
				mode
			};
			return {
				getSnapshot: () => snapshot,
				subscribe(listener) {
					listeners.add(listener);
					return () => listeners.delete(listener);
				},
				async set() {},
				async dispose() {
					listeners.clear();
				}
			};
		}

		function createMirror() {
			const listeners = new Set();
			return {
				ensure() {},
				load() {
					return Promise.resolve();
				},
				subscribe(listener) {
					listeners.add(listener);
					return () => listeners.delete(listener);
				},
				describe() {
					return { namespaces: [] };
				}
			};
		}

		class SettingsScopeShim {
			constructor(ctx) {
				this.ctx = ctx;
				this.mirror = createMirror();
			}
			describe() {
				return this.mirror;
			}
			bind(spec) {
				const mode =
					typeof location !== "undefined" && location.hostname === "127.0.0.1"
						? "host"
						: "memory";
				const scope = createMemoryScope(mode);
				this.ctx.effect(() => {
					return () => {
						void scope.dispose();
					};
				}, "settings-scope-shim: " + ((spec && spec.namespace) || "anonymous"));
				return scope;
			}
		}

		class ShortcutsShim {
			constructor(ctx) {
				this.ctx = ctx;
				this.commands = new Map();
				this.catalog = {
					getSnapshot: () => ({ commands: [...this.commands.values()] }),
					subscribe() {
						return () => {};
					}
				};
				this.config = {
					getSnapshot: () => ({ sequence: 0, bindings: {} }),
					subscribe() {
						return () => {};
					}
				};
				this.fixedCatalog = this.catalog;
			}
			register(command) {
				if (!command || typeof command.id !== "string") {
					throw new Error("settings-scope-shim: shortcuts.register requires id");
				}
				if (this.commands.has(command.id)) {
					throw new Error("Duplicate shortcut id " + command.id);
				}
				this.commands.set(command.id, command);
				const dispose = () => {
					this.commands.delete(command.id);
				};
				this.ctx.effect(() => dispose, "settings-scope-shim: shortcut " + command.id);
				return { id: command.id, dispose };
			}
			async recording() {}
			async closeWindow() {}
		}

		/** Registration sink: accepts definitions, returns a no-op disposer. */
		function createRegistry(label) {
			const items = new Map();
			return {
				register(definition) {
					const id = (definition && (definition.kind || definition.id)) || String(items.size);
					items.set(id, definition);
					return () => items.delete(id);
				},
				unregister(id) {
					items.delete(id);
				},
				list() {
					return [...items.values()];
				},
				getSnapshot() {
					return { items: [...items.values()] };
				},
				subscribe() {
					return () => {};
				},
				label: label
			};
		}

		function createUiConversationShim() {
			return {
				events: createRegistry("uiConversation.events"),
				views: createRegistry("uiConversation.views")
			};
		}

		function createUiWorkspaceShim() {
			const list = {
				getSnapshot: () => ({
					phase: "ready",
					items: [],
					pinnedSessionIds: [],
					archivedSessionIds: []
				}),
				subscribe() {
					return () => {};
				}
			};
			return {
				list,
				openSession() {},
				unarchiveSession() {
					return Promise.resolve();
				},
				connectWorkspace() {
					return Promise.resolve(undefined);
				}
			};
		}

		function createJobsShim() {
			const list = {
				getSnapshot: () => ({ items: [], byId: {} }),
				subscribe() {
					return () => {};
				}
			};
			return {
				list,
				getSnapshot: () => list.getSnapshot(),
				subscribe: (fn) => list.subscribe(fn)
			};
		}

		function createUiSessionShim() {
			const list = {
				getSnapshot: () => ({
					phase: "ready",
					ids: [],
					byId: {},
					current: undefined
				}),
				subscribe() {
					return () => {};
				}
			};
			return {
				list,
				sessionStatus: {
					getSnapshot: () => ({}),
					subscribe() {
						return () => {};
					}
				},
				scopeOf() {
					return undefined;
				}
			};
		}

		function createSidebarRightShim() {
			const tabs = {
				getSnapshot: () => ({ tabs: [] }),
				subscribe() {
					return () => {};
				}
			};
			return {
				tabs,
				register() {
					return () => {};
				},
				open() {},
				close() {}
			};
		}

		function createResourcesShim() {
			return {
				source() {
					return {
						getSnapshot: () => null,
						subscribe() {
							return () => {};
						}
					};
				},
				register() {
					return () => {};
				}
			};
		}

		const name = "settings-scope-shim";
		const inject = [];

		function apply(ctx) {
			const provide = (key, value) => {
				try {
					ctx.reflect.provide(key, value);
				} catch (error) {
					/* already provided by a real plugin — keep the real one */
					console.warn("settings-scope-shim: provide(" + key + ") skipped:", error && error.message);
				}
			};
			provide("settingsScope", new SettingsScopeShim(ctx));
			provide("shortcuts", new ShortcutsShim(ctx));
			provide("uiConversation", createUiConversationShim());
			provide("uiWorkspace", createUiWorkspaceShim());
			provide("jobs", createJobsShim());
			provide("uiSession", createUiSessionShim());
			provide("sidebarRight", createSidebarRightShim());
			provide("sidebarRightTabs", createSidebarRightShim().tabs);
			provide("resources", createResourcesShim());
		}

		exports.apply = apply;
		exports.inject = inject;
		exports.name = name;
		return module.exports;
	}
});
