window.__ModuleLoader__.load({
	id: "@dsh-external/dsh-settings-scope-shim",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		/* localStorage-backed settings scope (2026-09-29): the previous implementation
		* reported status "unavailable" (outside the ready/loading branches consumers
		* switch on) and had a no-op set(), so every write through it silently failed —
		* the internal-testing notice's acknowledge() then surfaced
		* "暂时无法保存确认状态，请重试。". Same read surface as before
		* (getSnapshot/subscribe/set/dispose), but it actually persists per namespace. */
		function createMemoryScope(mode, namespace) {
			const listeners = new Set();
			const storageKey = "dsh-desktop-settings-scope:" + (namespace || "anonymous");
			let value = {};
			try {
				const stored = typeof localStorage !== "undefined" ? localStorage.getItem(storageKey) : null;
				if (stored !== null) value = JSON.parse(stored) ?? {};
			} catch { value = {}; }
			let revision = 0;
			const snapshot = () => ({
				status: "ready",
				value: { ...value },
				base: void 0,
				user: void 0,
				revision,
				writable: true,
				mode
			});
			const notify = () => {
				const next = snapshot();
				for (const listener of listeners) {
					try { listener(next); } catch { /* listener errors stay local */ }
				}
			};
			return {
				getSnapshot: snapshot,
				subscribe(listener) {
					listeners.add(listener);
					return () => listeners.delete(listener);
				},
				async set(field, next) {
					if (field === void 0) return;
					if (typeof field === "object" && field !== null) value = { ...value, ...field };
					else value[field] = next;
					revision += 1;
					try {
						if (typeof localStorage !== "undefined") localStorage.setItem(storageKey, JSON.stringify(value));
					} catch { /* storage unavailable: the in-memory value still applies */ }
					notify();
				},
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
				const namespace = (spec && spec.namespace) || "anonymous";
				const scope = createMemoryScope(mode, namespace);
				this.ctx.effect(() => {
					return () => {
						void scope.dispose();
					};
				}, "settings-scope-shim: " + namespace);
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

		function createLayoutShim() {
			const panelInfo = {
				getSnapshot: () => ({ sidebar: true, rightbar: false, panels: [] }),
				subscribe() {
					return () => {};
				}
			};
			return {
				panelInfo,
				toggleSidebar() {},
				selectPanel() {},
				openDetails() {},
				closeDetails() {},
				beginNavigation() {},
				retainMainPanels() {}
			};
		}

		function createUiConversationShim() {
			const events = createRegistry("uiConversation.events");
			const views = createRegistry("uiConversation.views");
			return {
				events,
				views,
				binding(binding) {
					const targets = new Map();
					return {
						target(name) {
							if (!targets.has(name)) {
								const listeners = new Set();
								targets.set(name, {
									getSnapshot: () => null,
									subscribe(listener) {
										listeners.add(listener);
										return () => listeners.delete(listener);
									}
								});
							}
							return targets.get(name);
						}
					};
				}
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
				},
				registerPendingInteraction(score) {
					return () => {};
				},
				provide() {
					return () => {};
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
					console.warn("settings-scope-shim: provide(" + key + ") skipped:", error && error.message);
				}
			};
			/* ONLY register names the kernel does NOT provide.
			 *
			 * cordis `reflect.provide` THROWS on a duplicate rather than returning the
			 * existing service (`cordis/lib/index.js:813`: `service "<name>" has been
			 * registered at <fiber>`), and this plugin is `immediately: true`, so it can
			 * win the registration race. Registering a name the official bundle also
			 * provides therefore makes the OFFICIAL plugin fail to activate — losing
			 * `layout` means the UI root slot never mounts (white screen).
			 *
			 * 0.1.7-rc.2 ships official providers for layout / shortcuts / jobs /
			 * resources / uiSession / uiWorkspace / sidebarRight / sidebarRightTabs
			 * (verified by grep on the 0.1.7 build), so those are deliberately NOT
			 * provided here any more. `settingsScope` is the one service 0.1.7 dropped
			 * while its consumers (dsh-client-ui-settings-models, ...-conversation)
			 * still inject it — that is the whole reason this shim exists.
			 * `uiConversation` has no provider on 0.1.7 either, so it stays harmless. */
			provide("settingsScope", new SettingsScopeShim(ctx));
			/* 2026-09-29: do NOT provide `uiConversation` any more. With the full 0.1.7
			* roster in place, `@deepseek-ai/dsh-client-ui-conversation` registers that
			* service itself (its `UiConversation` class calls `super(ctx, "uiConversation")`).
			* cordis' `reflect.provide` THROWS on a duplicate, so this shim's extra
			* registration made the official plugin fail to activate:
			*   `service "uiConversation" has been registered at <settings-scope-shim>`
			* which parked both `ui-conversation` and `ui-chat` (empty chat pane).
			* Only `settingsScope` — the one service 0.1.7 genuinely drops — stays here. */
			void createUiConversationShim;
		}

		exports.apply = apply;
		exports.inject = inject;
		exports.name = name;
		return module.exports;
	}
});
