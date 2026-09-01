// @dsh-external/dsh-prompt-enhance · client 层：设置页「提示词增强」面板
// 数据源：host 侧 POST /prompt-enhance/run（DeepSeek API 改写）
// 模式参照：dsh-skills-manager/lib/client.js + dsh-tool-visibility/lib/client.js
window.__ModuleLoader__.load({
	id: "@dsh-external/dsh-prompt-enhance",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		let react = require("react");

		function PromptEnhancePanel() {
			const [input, setInput] = react.useState("");
			const [output, setOutput] = react.useState("");
			const [loading, setLoading] = react.useState(false);
			const [error, setError] = react.useState(null);

			function enhance() {
				const text = input.trim();
				if (!text || loading) return;
				setLoading(true);
				setError(null);
				setOutput("");
				fetch("/prompt-enhance/run", {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ text })
				})
					.then((r) => r.json())
					.then((d) => {
						if (d.ok) {
							setOutput(d.enhanced);
						} else {
							setError(d.error || "未知错误");
						}
					})
					.catch((e) => setError(String((e && e.message) || e)))
					.finally(() => setLoading(false));
			}

			function copyOutput() {
				if (output) {
					navigator.clipboard.writeText(output).catch(() => {});
				}
			}

			return react.createElement("div", { className: "pe-wrap" },
				react.createElement("div", { className: "pe-head" },
					react.createElement("span", { className: "pe-title" }, "提示词增强"),
					react.createElement("span", { className: "pe-hint" }, "输入原始提示词，点击增强获取优化版本")
				),
				react.createElement("textarea", {
					className: "pe-input",
					rows: 6,
					placeholder: "在此输入要增强的提示词...",
					value: input,
					disabled: loading,
					onChange: (e) => setInput(e.target.value)
				}),
				react.createElement("div", { className: "pe-actions" },
					react.createElement("button", {
						className: "pe-btn" + (loading ? " pe-loading" : ""),
						disabled: loading || !input.trim(),
						onClick: enhance
					}, loading ? "增强中…" : "增强"),
					output ? react.createElement("button", {
						className: "pe-btn pe-copy",
						onClick: copyOutput
					}, "复制结果") : null
				),
				error ? react.createElement("div", { className: "pe-err" }, error) : null,
				output ? react.createElement("div", { className: "pe-result" },
					react.createElement("div", { className: "pe-result-label" }, "增强结果："),
					react.createElement("pre", { className: "pe-result-text" }, output)
				) : null
			);
		}

		function apply(ctx) {
			const slots = ctx.get("slots");
			if (slots === undefined) return;
			ctx.effect(() => {
				const style = document.createElement("style");
				style.textContent = ".pe-wrap{padding:4px 2px;font-size:13px;color:var(--dsw-alias-label-primary)}.pe-head{display:flex;align-items:center;gap:8px;margin-bottom:10px}.pe-title{font-size:15px;font-weight:600}.pe-hint{font-size:12px;color:var(--dsw-alias-label-secondary)}.pe-input{width:100%;box-sizing:border-box;padding:8px 10px;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font-size:13px;font-family:inherit;resize:vertical;margin-bottom:8px}.pe-input:focus{outline:none;border-color:var(--dsw-alias-state-focus-primary)}.pe-actions{display:flex;gap:8px;margin-bottom:10px}.pe-btn{padding:6px 16px;border:1px solid var(--dsw-alias-border-l1);border-radius:6px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);cursor:pointer;font-size:13px}.pe-btn:hover:not(:disabled){background:var(--dsw-alias-bg-layer-2)}.pe-btn:disabled{opacity:.5;cursor:default}.pe-btn.pe-loading{opacity:.7}.pe-btn.pe-copy{background:var(--dsw-alias-state-success-bg);border-color:var(--dsw-alias-state-success-border);color:var(--dsw-alias-state-success-text)}.pe-err{color:var(--dsw-alias-state-error-primary);font-size:12px;margin:6px 0}.pe-result{border:1px solid var(--dsw-alias-border-l1);border-radius:8px;padding:10px 12px;background:var(--dsw-alias-bg-layer-1)}.pe-result-label{font-size:12px;color:var(--dsw-alias-label-secondary);margin-bottom:6px}.pe-result-text{white-space:pre-wrap;word-break:break-all;font-size:13px;line-height:1.5;color:var(--dsw-alias-label-primary);margin:0}";
				document.head.appendChild(style);
				return () => { style.remove(); };
			}, "dsh-prompt-enhance: styles");
			slots.inject("settings.section", () => slots.register(
				{ name: "settings.section", id: "prompt-enhance", order: 27, label: "提示词增强" },
				() => react.createElement(PromptEnhancePanel)
			));
		}

		exports.apply = apply;
		return module.exports;
	}
});
