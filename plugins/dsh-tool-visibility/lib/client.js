// @dsh-external/dsh-tool-visibility · client 层：设置页「工具调用可见性」面板（方案书 v3 P2-A-0 展示层第一版）
// 数据源：host 侧 GET /tool-visibility/recent（内存环形缓冲，2s 轮询，失败静默降级）
// 模式参照：dsh-skills-manager/lib/client.js（已验证：__ModuleLoader__.load + require("react") + slots.inject("settings.section")）
window.__ModuleLoader__.load({
	id: "@dsh-external/dsh-tool-visibility",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		let react = require("react");

		function ToolVisibilityPanel() {
			const [calls, setCalls] = react.useState(null);
			const [error, setError] = react.useState(null);

			function load() {
				return fetch("/tool-visibility/recent")
					.then((r) => (r.ok ? r.json() : Promise.reject(new Error("HTTP " + r.status))))
					.then((d) => {
						setCalls(Array.isArray(d && d.calls) ? d.calls : []);
						setError(null);
					})
					.catch((e) => setError(String((e && e.message) || e)));
			}

			react.useEffect(() => {
				load();
				const timer = setInterval(load, 2000);
				return () => clearInterval(timer);
			}, []);

			const rows = (calls || []).map((c) =>
				react.createElement("div", { key: c.callId, className: "tv-row" },
					react.createElement("span", { className: "tv-name" }, c.name),
					react.createElement("span", { className: "tv-status tv-" + String(c.status || "unknown") }, c.status || "?"),
					typeof c.durationMs === "number"
						? react.createElement("span", { className: "tv-dur" }, c.durationMs + "ms")
						: null,
					c.argsSummary
						? react.createElement("pre", { className: "tv-args" }, c.argsSummary)
						: null
				)
			);

			return react.createElement("div", { className: "tv-wrap" },
				react.createElement("div", { className: "tv-head" },
					react.createElement("span", { className: "tv-title" }, "工具调用可见性"),
					react.createElement("span", { className: "tv-hint" }, "最近 " + (calls ? calls.length : 0) + " 条 · 2s 自动刷新")
				),
				error ? react.createElement("div", { className: "tv-err" }, error) : null,
				calls && calls.length === 0 ? react.createElement("div", { className: "tv-empty" }, "暂无工具调用记录") : null,
				rows
			);
		}

		function apply(ctx) {
			const slots = ctx.get("slots");
			if (slots === undefined) return;
			ctx.effect(() => {
				const style = document.createElement("style");
				style.textContent = ".tv-wrap{padding:4px 2px;font-size:13px;color:var(--dsw-alias-label-primary)}.tv-head{display:flex;align-items:center;gap:8px;margin-bottom:10px}.tv-title{font-size:15px;font-weight:600}.tv-hint{font-size:12px;color:var(--dsw-alias-label-secondary)}.tv-row{border:1px solid var(--dsw-alias-border-l1);border-radius:8px;padding:6px 10px;margin-bottom:6px;background:var(--dsw-alias-bg-layer-1);display:flex;align-items:center;gap:8px;flex-wrap:wrap}.tv-name{font-weight:600;font-family:monospace}.tv-status{font-size:11px;padding:1px 6px;border-radius:4px;background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l1)}.tv-status.tv-done{color:var(--dsw-alias-state-success-primary)}.tv-status.tv-error{color:var(--dsw-alias-state-error-primary)}.tv-dur{font-size:12px;color:var(--dsw-alias-label-secondary)}.tv-args{white-space:pre-wrap;word-break:break-all;font-size:12px;max-height:120px;overflow:auto;background:var(--dsw-alias-bg-layer-2);padding:4px 6px;border-radius:4px;margin:0;width:100%;color:var(--dsw-alias-label-secondary)}.tv-err{color:var(--dsw-alias-state-error-primary);font-size:12px;margin:6px 0}.tv-empty{color:var(--dsw-alias-label-secondary);font-size:12px}";
				document.head.appendChild(style);
				return () => { style.remove(); };
			}, "dsh-tool-visibility: styles");
			slots.inject("settings.section", () => slots.register(
				{ name: "settings.section", id: "tool-visibility", order: 28, label: "工具调用可见性" },
				() => react.createElement(ToolVisibilityPanel)
			));
		}

		exports.apply = apply;
		return module.exports;
	}
});
