// @dsh-external/dsh-frontend-reload — client 侧：右下角刷新按钮 + Ctrl+R / Ctrl+Shift+R 快捷键
// 背景：桌面壳（dsh-plugin-desktop）在 Windows 上 removeMenu() 且不安装应用菜单，
// reload 角色/快捷键从未注册（electron-platform.ts WindowsPlatformStrategy 空实现）。
// 本插件在页面内兜底：窗口级 keydown 捕获 Ctrl(+Shift)+R 触发 location.reload()，
// 并提供一个悬浮刷新按钮。纯 DOM 实现，无 React 依赖。
window.__ModuleLoader__.load({ id: '@dsh-external/dsh-frontend-reload', factory: (require) => {
	var module = { exports: {} };
	var exports = module.exports;
	Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });

	const inject = ['slots'];

	const BUTTON_ID = 'dsh-frontend-reload-btn';
	const CSS_ID = 'dsh-frontend-reload-css';
	const css = `
#${BUTTON_ID}{position:fixed;right:14px;bottom:14px;z-index:9999;width:30px;height:30px;border-radius:50%;
  border:1px solid var(--dsw-alias-border-l1, rgba(128,128,128,.4));background:var(--dsw-alias-bg-layer-2, rgba(30,30,30,.85));
  color:var(--dsw-alias-label-secondary, #bbb);font-size:15px;line-height:1;cursor:pointer;display:flex;align-items:center;justify-content:center;
  box-shadow:0 2px 8px rgba(0,0,0,.25);opacity:.55;transition:opacity .15s}
#${BUTTON_ID}:hover{opacity:1;color:var(--dsw-alias-label-primary, #fff)}
#${BUTTON_ID} svg{width:15px;height:15px;fill:currentColor}
`;

	function ensureCss() {
		if (document.getElementById(CSS_ID)) return;
		const tag = document.createElement('style');
		tag.id = CSS_ID;
		tag.textContent = css;
		document.head.appendChild(tag);
	}

	function mountButton() {
		if (document.getElementById(BUTTON_ID)) return;
		const btn = document.createElement('button');
		btn.id = BUTTON_ID;
		btn.type = 'button';
		btn.title = '刷新界面（等效 Ctrl+R）';
		btn.setAttribute('aria-label', '刷新界面');
		btn.innerHTML = '<svg viewBox="0 0 24 24"><path d="M17.65 6.35A7.95 7.95 0 0 0 12 4a8 8 0 1 0 7.73 10h-2.08A6 6 0 1 1 12 6c1.66 0 3.14.69 4.22 1.78L13 11h7V4l-2.35 2.35z"/></svg>';
		btn.addEventListener('click', (ev) => {
			ev.preventDefault();
			ev.stopPropagation();
			location.reload();
		});
		document.body.appendChild(btn);
	}

	function mountKeyHandler() {
		// 仅当没有比我们更早的处理器时接管；Ctrl(+Shift)+R 一律 reload
		window.addEventListener('keydown', (ev) => {
			const k = ev.key && ev.key.toLowerCase();
			if (k === 'r' && (ev.ctrlKey || ev.metaKey)) {
				ev.preventDefault();
				location.reload();
			}
		});
	}

	function apply() {
		if (typeof document === 'undefined') return;
		ensureCss();
		mountButton();
		mountKeyHandler();
	}

	module.exports = { inject, apply };
	return module.exports;
} });
