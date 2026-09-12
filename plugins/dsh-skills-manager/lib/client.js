window.__ModuleLoader__.load({
	id: "dsh-skills-manager",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");

		// O11：请求超时。后端挂起 / 弱网时 fetch 永不 settle —— UI 会永久停在加载
		// 态（市场安装按钮就卡在 busy），半开连接还会一直占着句柄。
		// 本 bundle 是 __ModuleLoader__ 独立作用域（不能跨插件共享工具），故内联一份。
		var API_TIMEOUT_MS = 30000;
		var MARKET_TIMEOUT_MS = 180000; // market.* 走网络（索引/下载），预算放宽
		function fetchWithTimeout(url, opts, timeoutMs) {
			var ms = timeoutMs || API_TIMEOUT_MS;
			var ac = new AbortController();
			var timer = setTimeout(function () { ac.abort(); }, ms);
			var o = Object.assign({}, opts || {}, { signal: ac.signal });
			return fetch(url, o).then(function (r) { clearTimeout(timer); return r; }, function (e) {
				clearTimeout(timer);
				if (e && (e.name === 'AbortError' || e.code === 20)) throw new Error("请求超时（" + Math.round(ms / 1000) + " 秒）");
				throw e;
			});
		}

		function callApi(method, args, timeoutMs) {
			var ms = timeoutMs || (/^market\./.test(String(method)) ? MARKET_TIMEOUT_MS : API_TIMEOUT_MS);
			return fetchWithTimeout("/skmg/api", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ method: method, args: args })
			}, ms).then((r) => r.json()).then((r) => {
				if (r && r.ok) return r.data;
				throw new Error((r && r.error) || "请求失败");
			});
		}

		function SkillsManager() {
			const [tab, setTab] = react.useState("system");
			const [data, setData] = react.useState(null);
			const [error, setError] = react.useState(null);
			const [msg, setMsg] = react.useState(null);
			const [expanded, setExpanded] = react.useState(null);
			const [details, setDetails] = react.useState(null);
			const [editor, setEditor] = react.useState(null);
			const [busy, setBusy] = react.useState(false);
			const [importPath, setImportPath] = react.useState("");
			const [importMsg, setImportMsg] = react.useState(null);
			const [importErr, setImportErr] = react.useState(null);

			function load() {
				setError(null);
				return callApi("list").then((r) => {
					setData(r);
					return r;
				}).catch((e) => {
					setError("加载失败：" + String((e && e.message) || e));
				});
			}

			react.useEffect(() => { load(); }, []);

			function showError(e) { setError("操作失败：" + String((e && e.message) || e)); }

			function doImport() {
				const folder = importPath.trim();
				if (!folder || busy) return;
				setBusy(true); setImportMsg(null); setImportErr(null);
				return callApi("importFolder", { path: folder }).then((r) => {
					setImportMsg("导入完成：新增 " + (r.imported ? r.imported.length : 0) + " 个" +
						((r.skipped && r.skipped.length) ? "，跳过 " + r.skipped.length + " 个（" + r.skipped.join("、") + "）" : "") +
						((r.errors && r.errors.length) ? "，失败 " + r.errors.length + " 个（" + r.errors.join("；") + "）" : ""));
					setImportPath("");
					return load();
				}).catch((e) => {
					setImportErr("导入失败：" + String((e && e.message) || e));
				}).then(() => setBusy(false));
			}

			function toggleDetail(skillName) {
				if (expanded === skillName) { setExpanded(null); setDetails(null); return; }
				setExpanded(skillName);
				setDetails(null);
				setMsg(null);
				callApi("get", { name: skillName }).then((d) => setDetails(d)).catch(showError);
			}

			function onToggle(skillName, enabled) {
				if (busy) return;
				setBusy(true); setMsg(null); setError(null);
				callApi("setEnabled", { name: skillName, enabled: enabled }).then(() => {
					setMsg("已" + (enabled ? "启用" : "禁用") + "：" + skillName);
					return load();
				}).catch(showError).then(() => setBusy(false));
			}

			function onDelete(skill) {
				if (busy) return;
				if (!window.confirm("确定删除用户 skill「" + skill.name + "」？此操作不可恢复。")) return;
				setBusy(true); setMsg(null); setError(null);
				callApi("delete", { name: skill.name }).then(() => {
					setMsg("已删除：" + skill.name);
					return load();
				}).catch(showError).then(() => setBusy(false));
			}

			function openCreate() {
				setError(null); setMsg(null);
				setEditor({ mode: "create", name: "", description: "", whenToUse: "", content: "" });
			}

			function openEdit(skill) {
				if (editor && editor.mode === "edit" && editor.name === skill.name) { setEditor(null); return; }
				setBusy(true); setMsg(null); setError(null);
				callApi("get", { name: skill.name }).then((d) => {
					if (!d) { setError("skill 不存在"); return; }
					setEditor({ mode: "edit", name: d.name, description: d.description || "", whenToUse: d.whenToUse || "", content: d.content || "" });
				}).catch(showError).then(() => setBusy(false));
			}

			function saveEditor() {
				if (!editor || busy) return;
				if (!String(editor.description || "").trim()) { setError("描述不能为空"); return; }
				setBusy(true); setMsg(null); setError(null);
				const args = {
					name: editor.name,
					description: String(editor.description || "").trim(),
					whenToUse: String(editor.whenToUse || "").trim(),
					content: String(editor.content || "")
				};
				const call = editor.mode === "create" ? callApi("create", args) : callApi("update", args);
				call.then(() => {
					const created = editor.mode === "create";
					const savedName = editor.name;
					setEditor(null);
					setMsg(created ? "已创建：" + savedName : "已保存：" + savedName);
					return load();
				}).catch(showError).then(() => setBusy(false));
			}

			function renderForm(key) {
				return react.createElement("div", { key: key, className: "skmg-form" },
					react.createElement("div", { className: "skmg-form-title" }, editor.mode === "create" ? "新建用户 Skill" : "编辑 Skill：" + editor.name),
					react.createElement("label", null, "名称（kebab-case，仅新建时可改）"),
					react.createElement("input", { value: editor.name, disabled: editor.mode === "edit" || busy, onChange: (e) => setEditor(Object.assign({}, editor, { name: e.target.value })) }),
					react.createElement("label", null, "描述（必填）"),
					react.createElement("input", { value: editor.description, disabled: busy, onChange: (e) => setEditor(Object.assign({}, editor, { description: e.target.value })) }),
					react.createElement("label", null, "适用场景 whenToUse（可选）"),
					react.createElement("input", { value: editor.whenToUse, disabled: busy, onChange: (e) => setEditor(Object.assign({}, editor, { whenToUse: e.target.value })) }),
					react.createElement("label", null, "正文（Markdown）"),
					react.createElement("textarea", { rows: 10, value: editor.content, disabled: busy, onChange: (e) => setEditor(Object.assign({}, editor, { content: e.target.value })) }),
					react.createElement("div", { className: "skmg-form-actions" },
						react.createElement("button", { className: "skmg-btn", disabled: busy, onClick: saveEditor }, "保存"),
						react.createElement("button", { className: "skmg-btn", disabled: busy, onClick: () => setEditor(null) }, "取消")
					)
				);
			}

			function renderCard(skill, isUser) {
				const open = expanded === skill.name;
				const d = open ? details : null;
				const enabled = skill.modelInvocable && skill.userInvocable;
				const writable = isUser && (skill.source === "user-dsh" || skill.source === "user-agents");
				const rows = [];
				if (open) {
					if (!d) rows.push(react.createElement("div", { key: "loading", className: "skmg-muted" }, "加载中…"));
					else {
						if (d.whenToUse) rows.push(react.createElement("div", { key: "when", className: "skmg-muted" }, "适用场景：" + d.whenToUse));
						if (d.path) rows.push(react.createElement("div", { key: "path", className: "skmg-muted" }, "路径：" + d.path));
						rows.push(react.createElement("div", { key: "inv", className: "skmg-muted" }, "模型可调用：" + (d.modelInvocable ? "是" : "否") + "　用户可调用：" + (d.userInvocable ? "是" : "否")));
						rows.push(react.createElement("pre", { key: "content", className: "skmg-pre" }, d.content));
					}
				}
				return react.createElement("div", { key: skill.name, className: "skmg-card" },
					react.createElement("div", { className: "skmg-card-head" },
						react.createElement("span", { className: "skmg-name", style: { cursor: "pointer" }, onClick: () => toggleDetail(skill.name) }, skill.name),
						react.createElement("span", { className: "skmg-badge" }, skill.source),
						react.createElement("span", { className: "skmg-badge" }, skill.provider),
						!enabled ? react.createElement("span", { className: "skmg-badge", style: { color: "var(--dsw-alias-state-warn-primary)" } }, "已禁用") : null,
						react.createElement("span", { style: { flex: 1 } }),
						writable ? react.createElement("label", { key: "sw", className: "skmg-switch" },
							react.createElement("input", { type: "checkbox", checked: enabled, disabled: busy, onChange: (e) => onToggle(skill.name, e.target.checked) }),
							react.createElement("span", null, "启用")
						) : null,
						writable ? react.createElement("button", { key: "edit", className: "skmg-btn", disabled: busy, onClick: () => openEdit(skill) }, "编辑") : null,
						writable ? react.createElement("button", { key: "del", className: "skmg-btn danger", disabled: busy, onClick: () => onDelete(skill) }, "删除") : null
					),
					react.createElement("div", { className: "skmg-desc" }, skill.description),
					open ? react.createElement("div", { key: "detail", className: "skmg-detail" }, rows) : null,
					editor && editor.mode === "edit" && editor.name === skill.name ? renderForm("edit-form") : null
				);
			}

			const system = data ? data.system : [];
			const user = data ? data.user : [];
			const list = tab === "system" ? system : user;

			return react.createElement("div", { className: "skmg-wrap" },
					react.createElement("div", { className: "skmg-head" },
						react.createElement("div", { className: "skmg-title" }, "Skills 管理器"),
						react.createElement("div", { className: "skmg-tabs" },
							react.createElement("button", { className: "skmg-tab" + (tab === "system" ? " on" : ""), onClick: () => setTab("system") }, "系统 Skills（" + system.length + "）"),
							react.createElement("button", { className: "skmg-tab" + (tab === "user" ? " on" : ""), onClick: () => setTab("user") }, "用户 Skills（" + user.length + "）"),
							react.createElement("button", { className: "skmg-tab" + (tab === "market" ? " on" : ""), onClick: () => setTab("market") }, "市场")
						),
						tab !== "market" ? react.createElement("button", { className: "skmg-btn", onClick: load, disabled: busy }, "刷新") : null
					),
					tab === "market" ? react.createElement(MarketView, { key: "market", onChanged: load }) :
						(tab === "user" ? react.createElement("div", { key: "userbar", className: "skmg-muted", style: { marginBottom: "8px" } },
							"用户根目录：" + (data && data.userRoot ? data.userRoot : "未定位"),
							react.createElement("button", { className: "skmg-btn", style: { marginLeft: "8px" }, onClick: openCreate, disabled: busy }, "＋ 新建 Skill")
						) : null),
					tab === "user" ? react.createElement("div", { key: "importbar", className: "skmg-import" },
						react.createElement("input", { className: "skmg-import-input", placeholder: "导入文件夹路径（含 SKILL.md 或其一层子目录）", value: importPath, disabled: busy, onChange: (e) => setImportPath(e.target.value) }),
						react.createElement("button", { className: "skmg-btn", disabled: busy || !importPath.trim(), onClick: doImport }, "导入文件夹"),
						importMsg ? react.createElement("div", { key: "im", className: "skmg-msg" }, importMsg) : null,
						importErr ? react.createElement("div", { key: "ie", className: "skmg-err" }, importErr) : null
					) : null,
					error ? react.createElement("div", { key: "err", className: "skmg-err" }, error) : null,
					msg ? react.createElement("div", { key: "msg", className: "skmg-msg" }, msg) : null,
					tab !== "market" ? (!data ? react.createElement("div", { key: "loading", className: "skmg-muted" }, "加载中…") :
						(list.length === 0 ? react.createElement("div", { key: "empty", className: "skmg-muted" }, tab === "system" ? "暂无系统 Skills" : "暂无用户 Skills，点击「＋ 新建 Skill」创建") :
							list.map((s) => renderCard(s, tab === "user")))) : null,
					tab !== "market" && editor && editor.mode === "create" ? renderForm("create-form") : null,
					tab !== "market" && data && data.debug ? react.createElement("div", { key: "dbg", className: "skmg-muted", style: { marginTop: "8px", fontSize: "11px" } },
						"扫描层：" + data.debug.layers.join(" / ") + "（共 " + data.debug.total + " 项）"
					) : null
				);
		}

		function MarketView(props) {
			const [sources, setSources] = react.useState([]);
			const [installed, setInstalled] = react.useState({});
			const [items, setItems] = react.useState([]);
			const [categories, setCategories] = react.useState([]);
			const [sourceState, setSourceState] = react.useState(null);
			const [stale, setStale] = react.useState(false);
			const [staleError, setStaleError] = react.useState(null);
			const [q, setQ] = react.useState("");
			const [category, setCategory] = react.useState("");
			const [manifestUrl, setManifestUrl] = react.useState("");
			const [busy, setBusy] = react.useState(false);
			const [error, setError] = react.useState(null);
			const [msg, setMsg] = react.useState(null);
			// T6：未过滤的全量条目缓存（治理总览用）。搜索/分类时 items 是子集，
			// 不能拿子集算统计 —— 否则一搜索统计就"缩水"，显示不实。
			const [allItems, setAllItems] = react.useState([]);

			function loadSources(selectAfter) {
				return callApi("market.sources").then((r) => {
					setSources(r.sources || []);
					const inst = {};
					(r.installed || []).forEach((i) => { inst[i.skillId] = i; });
					setInstalled(inst);
					return r;
				}).then((r) => {
					const selected = (r.sources || []).find((s) => s.selected);
					if (selectAfter) {
						return callApi("market.selectSource", selectAfter).then(() => loadSources()).then(() => reloadList());
					}
					if (selected) { setSourceState(selected); return reloadList(); }
					setSourceState(null);
					setItems([]);
					return null;
				});
			}

			function reloadList() {
				return callApi("market.list", { q: q, category: category }).then((r) => {
					setItems(r.items || []);
					// 仅在无过滤时把结果作为"全量"缓存（统计口径 = 目录全量）
					if (!String(q || "").trim() && !category) setAllItems(r.items || []);
					setCategories(r.categories || []);
					setStale(!!r.stale);
					setStaleError(r.staleError || null);
					return r;
				}).catch((e) => {
					setError("市场加载失败：" + String((e && e.message) || e));
				});
			}

			react.useEffect(() => {
				setBusy(true);
				loadSources().catch((e) => { setError("市场初始化失败：" + String((e && e.message) || e)); }).then(() => setBusy(false));
			}, []);

			function showError(e) { setError("操作失败：" + String((e && e.message) || e)); }

			function onAddSource() {
				const url = String(manifestUrl || "").trim();
				if (!url) { setError("请输入 manifest URL"); return; }
				setBusy(true); setError(null); setMsg(null);
				callApi("market.addSource", url).then((r) => {
					setManifestUrl("");
					setMsg("源已添加，请选择后浏览");
					return loadSources(r.recordId);
				}).catch(showError).then(() => setBusy(false));
			}

			function onRemoveSource(recordId) {
				if (!window.confirm("确定移除该目录源？已安装的 skill 不受影响。")) return;
				setBusy(true); setError(null); setMsg(null);
				callApi("market.removeSource", recordId).then(() => loadSources()).catch(showError).then(() => setBusy(false));
			}

			function onSelect(recordId) {
				setBusy(true); setError(null); setMsg(null);
				callApi("market.selectSource", recordId).then(() => loadSources()).catch(showError).then(() => setBusy(false));
			}

			function onInstall(skill) {
				if (!window.confirm("安装市场 skill「" + skill.id + "」（v" + skill.version + "）？\n来源：" + (sourceState && sourceState.endpoint ? sourceState.endpoint : "未知"))) return;
				setBusy(true); setError(null); setMsg(null);
				callApi("market.install", { skillId: skill.id }).then((d) => {
					setMsg("已安装：" + skill.id + (d && d.whenToUse ? "（whenToUse: " + d.whenToUse + "）" : ""));
					return loadSources();
				}).then(() => props.onChanged()).catch(showError).then(() => setBusy(false));
			}

			function onAdopt(skill) {
				if (!window.confirm("接管本地 skill「" + skill.id + "」？\n\n市场只登记台账（不修改任何文件）；之后可用「更新」把本地内容对齐到目录 v" + skill.version + "，或用「卸载」删除本地目录。")) return;
				setBusy(true); setError(null); setMsg(null);
				callApi("market.adopt", { skillId: skill.id }).then((d) => {
					setMsg("已接管：" + skill.id + (d && d.localModelInvocable === false
						? "（本地已屏蔽 disable-model-invocation；「更新」会覆盖该改造，需二次确认）"
						: d && d.contentMatches === false
							? "（本地内容与目录 v" + d.catalogVersion + " 不一致，默认保留本地）"
							: "（内容与目录一致）"));
					return loadSources();
				}).then(() => props.onChanged()).catch(showError).then(() => setBusy(false));
			}

			function onUpdate(skill) {
				const slim = (skill.localModelInvocable === false) ||
					!!(installed[skill.id] && installed[skill.id].localModelInvocable === false);
				const warn = slim
					? "\n\n⚠️ 该 skill 本地带 disable-model-invocation:true（有意屏蔽，用于把模型 catalog 压在 9KB 安全线下）。\n更新会覆盖这一改造，使 catalog 重新变大 —— 本项目实测过这会把锚定率从 ~81% 拉到 0%。\n"
					: "";
				if (!window.confirm("更新 market skill「" + skill.id + "」到 v" + skill.version + "？\n\n会用目录内容覆盖本地 SKILL.md；覆盖前自动备份本地原文到 ~/.dsh/.skills-market/backups/。" + warn)) return;
				setBusy(true); setError(null); setMsg(null);
				callApi("market.update", { skillId: skill.id, confirmLocalMods: true }).then(() => {
					setMsg("已更新：" + skill.id);
					return loadSources();
				}).then(() => props.onChanged()).catch(showError).then(() => setBusy(false));
			}

			function onUninstall(skill) {
				const slim = skill.localModelInvocable === false
					? "\n（本地带 disable-model-invocation:true，备份会一并保留）"
					: "";
				const extra = skill && skill.installedAdopted
					? "\n注意：该记录由「接管」建立，本地目录内容可能是你自行安装或编辑过的。"
					: "";
				if (!window.confirm("卸载 market skill「" + skill.id + "」？\n\n会从 ~/.dsh/skills/" + skill.id + " 永久删除该目录（该路径不在回收站保护范围内）；删除前会自动整目录备份到 ~/.dsh/.skills-market/backups/uninstalled/，可据此恢复。" + slim + extra)) return;
				setBusy(true); setError(null); setMsg(null);
				callApi("market.uninstall", { skillId: skill.id }).then((d) => {
					setMsg("已卸载：" + skill.id + (d && d.backup ? "（备份：" + d.backup + "）" : ""));
					return loadSources();
				}).then(() => props.onChanged()).catch(showError).then(() => setBusy(false));
			}

			function renderCard(skill) {
				const inst = installed[skill.id];
				const localOnly = !inst && skill.localExists;
				// T3 四态：市场已安装 / 已接管（可能待对齐）/ 本地已存在可接管 / hub 管理不可接管 / 全新可安装
				const adoptedStale = !!(inst && inst.adopted && inst.contentMatches === false);
				const instLabel = !inst ? null
					: adoptedStale ? "已接管（本地已改造，目录 v" + (inst.catalogVersion || skill.version) + "）"
					: inst.adopted ? "已接管 v" + (inst.version || inst.catalogVersion || "?")
					: "已安装 v" + inst.version;
				const canAdopt = localOnly && !skill.hubManaged && skill.localSource === "user-dsh";
				// T5：本地「有意改造」标记（disable-model-invocation:true，SL-9 catalog 瘦身用）
				const slimmed = skill.localModelInvocable === false || !!(inst && inst.localModelInvocable === false);
				return react.createElement("div", { key: skill.id, className: "skmg-card" },
					react.createElement("div", { className: "skmg-card-head" },
						react.createElement("span", { className: "skmg-name" }, skill.id),
						(skill.categories || []).map((c) => react.createElement("span", { key: c, className: "skmg-badge" }, c)),
						react.createElement("span", { className: "skmg-badge" }, "目录 v" + skill.version),
						slimmed ? react.createElement("span", { className: "skmg-badge", style: { color: "var(--dsw-alias-state-warn-primary)" } }, "已屏蔽(SL-9)") : null,
						inst ? react.createElement("span", { className: "skmg-badge", style: { color: adoptedStale ? "var(--dsw-alias-state-warn-primary)" : "var(--dsw-alias-state-success-primary)" } }, instLabel) : null,
						localOnly ? react.createElement("span", { className: "skmg-badge", style: { color: "var(--dsw-alias-state-warn-primary)" } }, skill.hubManaged ? "hub 管理" : "本地已存在") : null,
						react.createElement("span", { style: { flex: 1 } }),
						(inst ? react.createElement(react.Fragment, null,
								react.createElement("button", { key: "update", className: "skmg-btn", disabled: busy, onClick: () => onUpdate(skill) }, "更新"),
								react.createElement("button", { key: "uninstall", className: "skmg-btn danger", disabled: busy, onClick: () => onUninstall(skill) }, "卸载")
							) :
							canAdopt ? react.createElement("button", { key: "adopt", className: "skmg-btn", disabled: busy, onClick: () => onAdopt(skill) }, "接管") :
							localOnly ? react.createElement("span", { key: "local-hint", className: "skmg-muted", style: { fontSize: "11px" } },
								skill.hubManaged
									? "由本地 hub 安装并记录 SHA-256，市场不接管（避免破坏 hub 完整性记录）"
									: "本地已存在（来源：" + (skill.localSource || "本地") + "），该来源市场无法管理") :
							react.createElement("button", { key: "install", className: "skmg-btn", disabled: busy, onClick: () => onInstall(skill) }, "安装"))
					),
					react.createElement("div", { className: "skmg-desc" }, skill.description),
					skill.author && skill.author.name ? react.createElement("div", { className: "skmg-muted", style: { marginTop: "4px", fontSize: "11px" } }, "作者：" + skill.author.name + (skill.author.url ? " · " + skill.author.url : "")) : null,
					adoptedStale ? react.createElement("div", { className: "skmg-muted", style: { marginTop: "2px", fontSize: "11px", color: "var(--dsw-alias-state-warn-primary)" } }, "本地已改造（与目录 v" + (inst.catalogVersion || skill.version) + " 不一致）：默认保留本地；点「更新」会覆盖改造（覆盖前自动备份原文）") : null,
					react.createElement("div", { className: "skmg-muted", style: { marginTop: "2px", fontSize: "11px" } }, "目录 SHA-256（安装时校验）: " + skill.download.sha256),
					inst && inst.sha256 && inst.sha256 !== skill.download.sha256
						? react.createElement("div", { className: "skmg-muted", style: { marginTop: "2px", fontSize: "11px", color: "var(--dsw-alias-state-warn-primary)" } }, "本地 SHA-256: " + inst.sha256 + "（与目录不同 → 本地已改造）")
						: null
				);
			}

			// T6 治理总览：把「三源真相」的分布直接摆到页面上（此前只有跑脚本才知道）。
			// 口径 = 目录全量（allItems），不受搜索/分类过滤影响。
			const srcAll = allItems.length ? allItems : items;
			// 分区必须互斥（否则徽标数相加 ≠ 目录总数，就是"显示不正确"）：
			//   市场管理（有台账） / 可接管（本地 user-dsh、无台账、非 hub） / hub 管理（本地、有 hub SHA 记录）
			//   / 其他来源（本地但既非 user-dsh 也非 hub） / 可安装（本地不存在且无台账）
			const stats = {
				total: srcAll.length,
				installed: srcAll.filter((x) => x.installed).length,
				adoptable: srcAll.filter((x) => !x.installed && x.localExists && !x.hubManaged && x.localSource === "user-dsh").length,
				hubManaged: srcAll.filter((x) => !x.installed && x.hubManaged).length,
				localOther: srcAll.filter((x) => !x.installed && x.localExists && !x.hubManaged && x.localSource !== "user-dsh").length,
				installable: srcAll.filter((x) => !x.installed && !x.localExists).length
			};
			return react.createElement("div", { className: "skmg-market" },
				react.createElement("div", { className: "skmg-muted", style: { marginBottom: "8px" } },
					"目录源：",
					sources.length === 0 ? "未添加（先在下方添加 manifest URL）" : null
				),
				sources.map((s) => react.createElement("div", { key: s.recordId, className: "skmg-card", style: { padding: "6px 10px", marginBottom: "6px" } },
					react.createElement("div", { className: "skmg-card-head" },
						react.createElement("input", { type: "radio", checked: !!s.selected, disabled: busy, onChange: () => onSelect(s.recordId) }),
						react.createElement("span", { className: "skmg-name", style: { fontSize: "12px" } }, s.name || s.providerId),
						react.createElement("span", { className: "skmg-badge" }, s.providerId),
						react.createElement("span", { style: { flex: 1 } }),
						react.createElement("button", { className: "skmg-btn danger", disabled: busy, onClick: () => onRemoveSource(s.recordId) }, "移除")
					),
					react.createElement("div", { className: "skmg-muted", style: { fontSize: "11px", marginTop: "2px" } }, s.endpoint)
				)),
				sourceState ? react.createElement("div", { className: "skmg-card", style: { padding: "6px 10px", marginBottom: "6px" } },
					react.createElement("div", { className: "skmg-card-head" },
						react.createElement("span", { className: "skmg-name", style: { fontSize: "12px" } }, "治理总览"),
						react.createElement("span", { className: "skmg-badge" }, "目录 " + stats.total + " 项"),
						react.createElement("span", { className: "skmg-badge", style: { color: "var(--dsw-alias-state-success-primary)" } }, "市场管理 " + stats.installed),
						react.createElement("span", { className: "skmg-badge" }, "可安装 " + stats.installable),
						react.createElement("span", { className: "skmg-badge", style: { color: stats.adoptable > 0 ? "var(--dsw-alias-state-warn-primary)" : undefined } }, "可接管 " + stats.adoptable),
						react.createElement("span", { className: "skmg-badge" }, "hub 管理 " + stats.hubManaged),
						stats.localOther ? react.createElement("span", { className: "skmg-badge" }, "其他来源 " + stats.localOther) : null
					),
					react.createElement("div", { className: "skmg-muted", style: { marginTop: "2px", fontSize: "11px" } },
						"「市场管理」＝可在本页更新/卸载；「可接管」＝本地已有但市场无台账，点接管即纳入管理（只登记台账、不改文件）；「hub 管理」有 hub 的 SHA-256 记录，市场不接管；本地已改造（含 disable-model-invocation 屏蔽）会在卡片上单独标注"
					)
				) : null,
				react.createElement("div", { className: "skmg-form", style: { marginTop: "8px" } },
					react.createElement("div", { className: "skmg-form-title" }, "添加目录源（manifest URL）"),
					react.createElement("input", { value: manifestUrl, disabled: busy, placeholder: "https://example.com/skills-manifest.json", onChange: (e) => setManifestUrl(e.target.value) }),
					react.createElement("div", { className: "skmg-form-actions" },
						react.createElement("button", { className: "skmg-btn", disabled: busy, onClick: onAddSource }, "添加"),
						react.createElement("button", { className: "skmg-btn", disabled: busy, onClick: () => loadSources() }, "刷新")
					)
				),
				sourceState ? react.createElement("div", { className: "skmg-head", style: { marginTop: "12px" } },
					react.createElement("div", { className: "skmg-title", style: { fontSize: "13px" } }, "市场条目"),
					react.createElement("input", { style: { flex: 1, minWidth: "120px" }, value: q, disabled: busy, placeholder: "搜索…", onChange: (e) => setQ(e.target.value), onKeyDown: (e) => { if (e.key === "Enter") { reloadList(); } } }),
					categories.length > 0 ? react.createElement("select", { value: category, disabled: busy, onChange: (e) => setCategory(e.target.value) },
						react.createElement("option", { value: "" }, "全部分类"),
						categories.map((c) => react.createElement("option", { key: c, value: c }, c))
					) : null,
					react.createElement("button", { className: "skmg-btn", disabled: busy, onClick: () => reloadList() }, "查询")
				) : null,
				stale ? react.createElement("div", { key: "stale", className: "skmg-err" }, "远程目录暂不可用，展示缓存数据（" + (staleError || "未知原因") + "）") : null,
				error ? react.createElement("div", { key: "err", className: "skmg-err" }, error) : null,
				msg ? react.createElement("div", { key: "msg", className: "skmg-msg" }, msg) : null,
				sourceState ? (items.length === 0 ? react.createElement("div", { key: "empty", className: "skmg-muted" }, "暂无条目（或搜索无结果）") : items.map(renderCard)) : null
			);
		}

		function apply(ctx) {
			const slots = ctx.get("slots");
			if (slots === undefined) return;
			ctx.effect(() => {
				const style = document.createElement("style");
				style.textContent = ".skmg-wrap{padding:4px 2px;font-size:13px;color:var(--dsw-alias-label-primary)}.skmg-head{display:flex;align-items:center;gap:8px;margin-bottom:10px;flex-wrap:wrap}.skmg-title{font-size:15px;font-weight:600;margin-right:4px}.skmg-tabs{display:flex;gap:6px}.skmg-tab{padding:4px 12px;border:1px solid var(--dsw-alias-border-l1);border-radius:6px;background:transparent;color:var(--dsw-alias-label-primary);cursor:pointer}.skmg-tab.on{background:var(--dsw-specific-sidebar-nav-item-active);border-color:transparent;color:var(--dsw-alias-label-primary)}.skmg-btn{padding:4px 10px;border:1px solid var(--dsw-alias-border-l1);border-radius:6px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);cursor:pointer;font-size:12px}.skmg-btn:disabled{opacity:.5;cursor:default}.skmg-btn.danger{color:var(--dsw-alias-state-error-primary);border-color:var(--dsw-alias-state-error-primary)}.skmg-card{border:1px solid var(--dsw-alias-border-l1);border-radius:8px;padding:8px 10px;margin-bottom:8px;background:var(--dsw-alias-bg-layer-1)}.skmg-card-head{display:flex;align-items:center;gap:8px;flex-wrap:wrap}.skmg-name{font-weight:600}.skmg-badge{font-size:11px;padding:1px 6px;border-radius:4px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);border:1px solid var(--dsw-alias-border-l1)}.skmg-desc{margin-top:4px;color:var(--dsw-alias-label-secondary)}.skmg-detail{margin-top:8px;border-top:1px solid var(--dsw-alias-border-l1);padding-top:8px}.skmg-pre{white-space:pre-wrap;word-break:break-all;font-size:12px;max-height:300px;overflow:auto;background:var(--dsw-alias-bg-layer-2);padding:8px;border-radius:6px;margin:6px 0 0}.skmg-form{margin-top:12px;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;padding:10px 12px;background:var(--dsw-alias-bg-layer-1)}.skmg-form-title{font-weight:600;margin-bottom:4px}.skmg-form label{display:block;margin:8px 0 2px;color:var(--dsw-alias-label-secondary);font-size:12px}.skmg-form input,.skmg-form textarea{width:100%;box-sizing:border-box;padding:6px 8px;border:1px solid var(--dsw-alias-border-l1);border-radius:6px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);font-size:13px;font-family:inherit}.skmg-form textarea{resize:vertical}.skmg-form-actions{display:flex;gap:8px;margin-top:10px}.skmg-err{color:var(--dsw-alias-state-error-primary);font-size:12px;margin:6px 0}.skmg-msg{color:var(--dsw-alias-state-success-primary);font-size:12px;margin:6px 0}.skmg-muted{color:var(--dsw-alias-label-secondary);font-size:12px}.skmg-switch{display:inline-flex;align-items:center;gap:4px;cursor:pointer;font-size:12px}.skmg-import{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:10px}.skmg-import-input{flex:1;min-width:240px;box-sizing:border-box;padding:6px 8px;border:1px solid var(--dsw-alias-border-l1);border-radius:6px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);font-size:12px;font-family:inherit}.VOzbGW_navList>button:last-child .VOzbGW_navIcon svg{display:none}.VOzbGW_navList>button:last-child .VOzbGW_navIcon{width:16px;height:16px;background:var(--dsw-alias-label-primary);-webkit-mask:url('data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20width%3D%2216%22%20height%3D%2216%22%20viewBox%3D%220%200%2016%2016%22%20fill%3D%22none%22%3E%3Cpath%20d%3D%22M8%202.2C8.4%204.5%209.4%205.6%2011.5%206.1C9.4%206.6%208.4%207.7%208%2010C7.6%207.7%206.6%206.6%204.5%206.1C6.6%205.6%207.6%204.5%208%202.2Z%22%20stroke%3D%22black%22%20stroke-width%3D%221.4%22%20stroke-linecap%3D%22round%22%20stroke-linejoin%3D%22round%22%2F%3E%3Cpath%20d%3D%22M12.3%2011.3C12.5%2012.2%2013%2012.7%2013.8%2012.9C13%2013.1%2012.5%2013.6%2012.3%2014.5C12.1%2013.6%2011.6%2013.1%2010.8%2012.9C11.6%2012.7%2012.1%2012.2%2012.3%2011.3Z%22%20stroke%3D%22black%22%20stroke-width%3D%221.4%22%20stroke-linecap%3D%22round%22%20stroke-linejoin%3D%22round%22%2F%3E%3C%2Fsvg%3E') center/contain no-repeat;mask:url('data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20width%3D%2216%22%20height%3D%2216%22%20viewBox%3D%220%200%2016%2016%22%20fill%3D%22none%22%3E%3Cpath%20d%3D%22M8%202.2C8.4%204.5%209.4%205.6%2011.5%206.1C9.4%206.6%208.4%207.7%208%2010C7.6%207.7%206.6%206.6%204.5%206.1C6.6%205.6%207.6%204.5%208%202.2Z%22%20stroke%3D%22black%22%20stroke-width%3D%221.4%22%20stroke-linecap%3D%22round%22%20stroke-linejoin%3D%22round%22%2F%3E%3Cpath%20d%3D%22M12.3%2011.3C12.5%2012.2%2013%2012.7%2013.8%2012.9C13%2013.1%2012.5%2013.6%2012.3%2014.5C12.1%2013.6%2011.6%2013.1%2010.8%2012.9C11.6%2012.7%2012.1%2012.2%2012.3%2011.3Z%22%20stroke%3D%22black%22%20stroke-width%3D%221.4%22%20stroke-linecap%3D%22round%22%20stroke-linejoin%3D%22round%22%2F%3E%3C%2Fsvg%3E') center/contain no-repeat}";
				document.head.appendChild(style);
				return () => { style.remove(); };
			}, "dsh-skills-manager: styles");
			slots.inject("settings.section", () => slots.register(
				{ name: "settings.section", id: "skills-manager", order: 30, label: "Skills" },
				() => react.createElement(SkillsManager)
			));
		}

		exports.apply = apply;
		return module.exports;
	}
});
