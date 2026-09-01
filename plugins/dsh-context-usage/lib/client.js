// @dsh-external/dsh-context-usage · client 层：设置页「上下文用量」面板
// 数据源：host 侧 /context-usage/status（2s 轮询）
// 模式参照：dsh-tool-visibility/lib/client.js + dsh-skills-manager/lib/client.js
window.__ModuleLoader__.load({
	id: "@dsh-external/dsh-context-usage",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		let react = require("react");

		function formatTokens(n) {
			if (n === 0) return "0"
			if (n >= 1000000) return (n / 1000000).toFixed(1) + "M"
			if (n >= 1000) return (n / 1000).toFixed(1) + "K"
			return String(n)
		}

		function ContextUsagePanel() {
			const [data, setData] = react.useState(null);
			const [error, setError] = react.useState(null);

			function load() {
				return fetch("/context-usage/status")
					.then((r) => (r.ok ? r.json() : Promise.reject(new Error("HTTP " + r.status))))
					.then((d) => { setData(d); setError(null); })
					.catch((e) => setError(String((e && e.message) || e)));
			}

			react.useEffect(() => {
				load();
				const timer = setInterval(load, 2000);
				return () => clearInterval(timer);
			}, []);

			const pct = data && data.ok ? data.percentage : 0;
			const barColor = pct < 60 ? "var(--dsw-alias-state-success-primary)"
				: pct < 85 ? "var(--dsw-alias-state-warn-primary)"
				: "var(--dsw-alias-state-error-primary)";

			return react.createElement("div", { className: "cu-wrap" },
				react.createElement("div", { className: "cu-head" },
					react.createElement("span", { className: "cu-title" }, "上下文用量"),
					react.createElement("span", { className: "cu-hint" }, "2s 自动刷新")
				),
				error ? react.createElement("div", { className: "cu-err" }, error) : null,
				data && data.ok ? react.createElement("div", { className: "cu-body" },
					react.createElement("div", { className: "cu-model" },
						react.createElement("span", { className: "cu-label" }, "模型"),
						react.createElement("span", { className: "cu-value" }, data.modelName)
					),
					react.createElement("div", { className: "cu-bar-wrap" },
						react.createElement("div", { className: "cu-bar-bg" },
							react.createElement("div", {
								className: "cu-bar-fill",
								style: { width: pct + "%", background: barColor }
							})
						),
						react.createElement("span", { className: "cu-pct" }, pct + "%")
					),
					react.createElement("div", { className: "cu-stats" },
						react.createElement("span", null, "表面 tokens: " + formatTokens(data.surfaceTokens)),
						react.createElement("span", null, "上下文窗口: " + formatTokens(data.contextWindow))
					)
				) : react.createElement("div", { className: "cu-muted" }, "等待数据...")
			);
		}

		function apply(ctx) {
			const slots = ctx.get("slots");
			if (slots === undefined) return;
			ctx.effect(() => {
				const style = document.createElement("style");
				style.textContent = ".cu-wrap{padding:4px 2px;font-size:13px;color:var(--dsw-alias-label-primary)}.cu-head{display:flex;align-items:center;gap:8px;margin-bottom:10px}.cu-title{font-size:15px;font-weight:600}.cu-hint{font-size:12px;color:var(--dsw-alias-label-secondary)}.cu-body{border:1px solid var(--dsw-alias-border-l1);border-radius:8px;padding:10px 12px;background:var(--dsw-alias-bg-layer-1)}.cu-model{display:flex;justify-content:space-between;margin-bottom:8px}.cu-label{color:var(--dsw-alias-label-secondary);font-size:12px}.cu-value{font-weight:600}.cu-bar-wrap{display:flex;align-items:center;gap:8px;margin-bottom:8px}.cu-bar-bg{flex:1;height:8px;border-radius:4px;background:var(--dsw-alias-bg-layer-2);overflow:hidden}.cu-bar-fill{height:100%;border-radius:4px;transition:width .3s ease}.cu-pct{font-weight:700;font-size:14px;min-width:36px;text-align:right}.cu-stats{display:flex;justify-content:space-between;font-size:12px;color:var(--dsw-alias-label-secondary)}.cu-muted{color:var(--dsw-alias-label-secondary);font-size:12px}.cu-err{color:var(--dsw-alias-state-error-primary);font-size:12px;margin:6px 0}";
				document.head.appendChild(style);
				return () => { style.remove(); };
			}, "dsh-context-usage: styles");
			slots.inject("settings.section", () => slots.register(
				{ name: "settings.section", id: "context-usage", order: 29, label: "上下文用量" },
				() => react.createElement(ContextUsagePanel)
			));
		}

		exports.apply = apply;
		return module.exports;
	}
});
