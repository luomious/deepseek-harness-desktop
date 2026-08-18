window.__ModuleLoader__.load({
	id: "dsh-skills-manager",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");

		function callApi(method, args) {
			return fetch("/skmg/api", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ method: method, args: args })
			}).then((r) => r.json()).then((r) => {
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
						react.createElement("button", { className: "skmg-tab" + (tab === "user" ? " on" : ""), onClick: () => setTab("user") }, "用户 Skills（" + user.length + "）")
					),
					react.createElement("button", { className: "skmg-btn", onClick: load, disabled: busy }, "刷新")
				),
				tab === "user" ? react.createElement("div", { key: "userbar", className: "skmg-muted", style: { marginBottom: "8px" } },
					"用户根目录：" + (data && data.userRoot ? data.userRoot : "未定位"),
					react.createElement("button", { className: "skmg-btn", style: { marginLeft: "8px" }, onClick: openCreate, disabled: busy }, "＋ 新建 Skill")
				) : null,
				error ? react.createElement("div", { key: "err", className: "skmg-err" }, error) : null,
				msg ? react.createElement("div", { key: "msg", className: "skmg-msg" }, msg) : null,
				!data ? react.createElement("div", { key: "loading", className: "skmg-muted" }, "加载中…") :
					(list.length === 0 ? react.createElement("div", { key: "empty", className: "skmg-muted" }, tab === "system" ? "暂无系统 Skills" : "暂无用户 Skills，点击「＋ 新建 Skill」创建") :
						list.map((s) => renderCard(s, tab === "user"))),
				editor && editor.mode === "create" ? renderForm("create-form") : null,
				data && data.debug ? react.createElement("div", { key: "dbg", className: "skmg-muted", style: { marginTop: "8px", fontSize: "11px" } },
					"扫描层：" + data.debug.layers.join(" / ") + "（共 " + data.debug.total + " 项）"
				) : null
			);
		}

		function apply(ctx) {
			const slots = ctx.get("slots");
			if (slots === undefined) return;
			ctx.effect(() => {
				const style = document.createElement("style");
				style.textContent = ".skmg-wrap{padding:4px 2px;font-size:13px;color:var(--dsw-alias-label-primary)}.skmg-head{display:flex;align-items:center;gap:8px;margin-bottom:10px;flex-wrap:wrap}.skmg-title{font-size:15px;font-weight:600;margin-right:4px}.skmg-tabs{display:flex;gap:6px}.skmg-tab{padding:4px 12px;border:1px solid var(--dsw-alias-border-l1);border-radius:6px;background:transparent;color:var(--dsw-alias-label-primary);cursor:pointer}.skmg-tab.on{background:var(--dsw-specific-sidebar-nav-item-active);border-color:transparent;color:var(--dsw-alias-label-primary)}.skmg-btn{padding:4px 10px;border:1px solid var(--dsw-alias-border-l1);border-radius:6px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);cursor:pointer;font-size:12px}.skmg-btn:disabled{opacity:.5;cursor:default}.skmg-btn.danger{color:var(--dsw-alias-state-error-primary);border-color:var(--dsw-alias-state-error-primary)}.skmg-card{border:1px solid var(--dsw-alias-border-l1);border-radius:8px;padding:8px 10px;margin-bottom:8px;background:var(--dsw-alias-bg-layer-1)}.skmg-card-head{display:flex;align-items:center;gap:8px;flex-wrap:wrap}.skmg-name{font-weight:600}.skmg-badge{font-size:11px;padding:1px 6px;border-radius:4px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);border:1px solid var(--dsw-alias-border-l1)}.skmg-desc{margin-top:4px;color:var(--dsw-alias-label-secondary)}.skmg-detail{margin-top:8px;border-top:1px solid var(--dsw-alias-border-l1);padding-top:8px}.skmg-pre{white-space:pre-wrap;word-break:break-all;font-size:12px;max-height:300px;overflow:auto;background:var(--dsw-alias-bg-layer-2);padding:8px;border-radius:6px;margin:6px 0 0}.skmg-form{margin-top:12px;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;padding:10px 12px;background:var(--dsw-alias-bg-layer-1)}.skmg-form-title{font-weight:600;margin-bottom:4px}.skmg-form label{display:block;margin:8px 0 2px;color:var(--dsw-alias-label-secondary);font-size:12px}.skmg-form input,.skmg-form textarea{width:100%;box-sizing:border-box;padding:6px 8px;border:1px solid var(--dsw-alias-border-l1);border-radius:6px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);font-size:13px;font-family:inherit}.skmg-form textarea{resize:vertical}.skmg-form-actions{display:flex;gap:8px;margin-top:10px}.skmg-err{color:var(--dsw-alias-state-error-primary);font-size:12px;margin:6px 0}.skmg-msg{color:var(--dsw-alias-state-success-primary);font-size:12px;margin:6px 0}.skmg-muted{color:var(--dsw-alias-label-secondary);font-size:12px}.skmg-switch{display:inline-flex;align-items:center;gap:4px;cursor:pointer;font-size:12px}.VOzbGW_navList>button:last-child .VOzbGW_navIcon svg{display:none}.VOzbGW_navList>button:last-child .VOzbGW_navIcon{width:16px;height:16px;background:var(--dsw-alias-label-primary);-webkit-mask:url('data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20width%3D%2216%22%20height%3D%2216%22%20viewBox%3D%220%200%2016%2016%22%20fill%3D%22none%22%3E%3Cpath%20d%3D%22M8%202.2C8.4%204.5%209.4%205.6%2011.5%206.1C9.4%206.6%208.4%207.7%208%2010C7.6%207.7%206.6%206.6%204.5%206.1C6.6%205.6%207.6%204.5%208%202.2Z%22%20stroke%3D%22black%22%20stroke-width%3D%221.4%22%20stroke-linecap%3D%22round%22%20stroke-linejoin%3D%22round%22%2F%3E%3Cpath%20d%3D%22M12.3%2011.3C12.5%2012.2%2013%2012.7%2013.8%2012.9C13%2013.1%2012.5%2013.6%2012.3%2014.5C12.1%2013.6%2011.6%2013.1%2010.8%2012.9C11.6%2012.7%2012.1%2012.2%2012.3%2011.3Z%22%20stroke%3D%22black%22%20stroke-width%3D%221.4%22%20stroke-linecap%3D%22round%22%20stroke-linejoin%3D%22round%22%2F%3E%3C%2Fsvg%3E') center/contain no-repeat;mask:url('data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20width%3D%2216%22%20height%3D%2216%22%20viewBox%3D%220%200%2016%2016%22%20fill%3D%22none%22%3E%3Cpath%20d%3D%22M8%202.2C8.4%204.5%209.4%205.6%2011.5%206.1C9.4%206.6%208.4%207.7%208%2010C7.6%207.7%206.6%206.6%204.5%206.1C6.6%205.6%207.6%204.5%208%202.2Z%22%20stroke%3D%22black%22%20stroke-width%3D%221.4%22%20stroke-linecap%3D%22round%22%20stroke-linejoin%3D%22round%22%2F%3E%3Cpath%20d%3D%22M12.3%2011.3C12.5%2012.2%2013%2012.7%2013.8%2012.9C13%2013.1%2012.5%2013.6%2012.3%2014.5C12.1%2013.6%2011.6%2013.1%2010.8%2012.9C11.6%2012.7%2012.1%2012.2%2012.3%2011.3Z%22%20stroke%3D%22black%22%20stroke-width%3D%221.4%22%20stroke-linecap%3D%22round%22%20stroke-linejoin%3D%22round%22%2F%3E%3C%2Fsvg%3E') center/contain no-repeat}";
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
