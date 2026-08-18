/**
* @dsh-external/dsh-system-notify — 系统通知插件
*
* 功能：
* 1. 自动提示：窗口未聚焦时，检测到新的助手回复（任务执行完成）→ 右上角弹 Windows toast。
* 2. 通用能力：向其他插件提供 ctx.notify service（show(title, body, opts)），
*    消费方插件在入口声明 exports.inject = ["notify"] 即可调用。
*
* 实现说明：
* - 渲染进程使用 Web Notification API（主进程已授权 notifications 权限），
*   Windows 上呈现为系统 toast（右上角弹出）。
* - 自动监听基于 MutationObserver 观察对话区新增 assistant-step 节点；
*   60 秒冷却 + 窗口聚焦时不打扰，避免刷屏。
*/
window.__ModuleLoader__.load({
	id: "@dsh-external/dsh-system-notify",
	factory: (require) => {
		console.log("[dsh-system-notify] factory executing");
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		/** 弹系统通知；返回是否已弹出（请求权限为异步时返回 true 但实际可能被拒）。 */
		function show(title, body, opts) {
			try {
				if (typeof window === "undefined" || !("Notification" in window)) return false;
				const doShow = () => {
					const n = new Notification(title || "DeepSeek Harness", {
						body: body || "",
						tag: (opts && opts.tag) || ("dsh-" + Date.now())
					});
					// 点击通知回到窗口（Electron 渲染器部分平台支持；不支持时无害）
					if (opts && opts.focusOnClick) {
						n.onclick = () => { try { window.focus(); } catch (e) { /* ignore */ } };
					}
					return true;
				};
				if (Notification.permission === "granted") return doShow();
				if (Notification.permission === "default") {
					Notification.requestPermission().then((perm) => {
						if (perm === "granted") doShow();
					}).catch((e) => {
						console.warn("[dsh-system-notify] permission request failed:", e && e.message || e);
					});
					return true;
				}
				return false;
			} catch (e) {
				console.warn("[dsh-system-notify] notification failed:", e && e.message || e);
				return false;
			}
		}

		/** 自动监听：窗口未聚焦 + 新助手回复出现 → 弹一次（60 秒冷却）。 */
		function watchAuto() {
			const COOLDOWN_MS = 60000;
			let lastShownAt = 0;
			const selector = '[data-chat-flow-kind="assistant-step"]';
			const onMutations = (records) => {
				try {
					if (document.hasFocus()) return;
					let added = 0;
					for (const r of records || []) {
						for (const n of r.addedNodes || []) {
							if (n.nodeType !== 1) continue;
							if ((n.matches && n.matches(selector)) || (n.querySelector && n.querySelector(selector))) added++;
						}
					}
					if (added === 0) return;
					const now = Date.now();
					if (now - lastShownAt < COOLDOWN_MS) return;
					lastShownAt = now;
					console.log("[dsh-system-notify] watch: +" + added + " assistant node(s), window not focused, showing notification");
					show("DeepSeek Harness", "任务执行完成，有新回复", { tag: "dsh-task-done-" + now, focusOnClick: true });
				} catch (e) {
					console.warn("[dsh-system-notify] watch error:", e && e.message || e);
				}
			};
			const observer = new MutationObserver(onMutations);
			// 观察 document.body（永不被 React 卸载替换）：conversation 滚动容器在
			// 会话切换/布局重建时会被卸载，观察它会导致 observer 自动断开、通知永久失效。
			let observedTarget = document.body;
			observer.observe(observedTarget, { childList: true, subtree: true });
			// 防御：每 30 秒无条件重附着（observe 幂等），自愈任何意外断开/容器替换
			const keepAlive = setInterval(() => {
				if (document.body.isConnected && observedTarget.isConnected) {
					observer.observe(observedTarget, { childList: true, subtree: true });
				}
			}, 30000);
			return { observer, keepAlive };
		}

		function apply(ctx) {
			try {
				ctx.provide("notify", { show: (title, body, opts) => show(title, body, opts) });
			} catch (e) {
				console.warn("[dsh-system-notify] provide notify service failed, auto-watch still active:", e && e.message || e);
			}
			try {
				const handle = watchAuto();
				try {
					// cordis ctx.effect(fn)：fn 立即执行，返回值是卸载时的 disposer。
					// 清理必须放返回的 disposer 里，否则 observer 会被当场断开。
					ctx.effect(() => () => {
						if (handle && handle.observer) handle.observer.disconnect();
						if (handle && handle.keepAlive) clearInterval(handle.keepAlive);
					}, "dsh-system-notify watch cleanup");
				} catch (e) { /* ctx.effect 不可用时依赖页面级生命周期，无残留风险 */ }
				console.log("[dsh-system-notify] ready, notification permission =", (typeof Notification !== "undefined" && Notification.permission) || "n/a");
			} catch (e) {
				console.warn("[dsh-system-notify] auto watch unavailable:", e && e.message || e);
			}
		}

		exports.apply = apply;
		return module.exports;
	}
});

//# sourceMappingURL=client.js.map