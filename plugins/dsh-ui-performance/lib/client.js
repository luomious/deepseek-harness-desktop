// @dsh-external/dsh-ui-performance — client 侧：设置面板渲染性能优化 + 面板尺寸/内容自适应（纯 CSS 注入，零 React 依赖）
//
// 依据（2026-08-26 排查；2026-08-26 dsh-deep-whale-main 皮肤已删除）：
// 1) @deepseek-ai/dsh-client-ui-settings-general/lib/client.js（SettingsRoot JSX）：
//    overlay(role="presentation") > mask(aria-hidden="true") + panel(role="dialog" aria-modal="true"，内含 <nav>)
//    遮罩 CSS：.VOzbGW_mask { backdrop-filter: var(--dsw-mask-blur); }  —— 全视口毛玻璃。
//    --dsw-mask-blur = blur(2px)（@deepseek-ai/dsh-client-ui-theme）。
// 2) 原 maid-atelier 皮肤（plugins/dsh-deep-whale-main，已删除）曾给面板本体加
//    backdrop-filter: blur(6px) saturate(0.9)，是设置页滑动卡顿的最强嫌疑；规则二为无害 no-op 保留。
//
// 设计原则：
// - 只用 role/aria 契约选择器，不依赖上游 hash 类名（上游重建类名变化时规则静默失效，回退原样，绝不影响布局）；
// - 全库仅两处 aria-modal="true" 对话框（设置面板 / 附件图片预览），且图片预览无 role="presentation"
//   包裹、无 <nav>，本选择器不会误伤其他弹窗；
// - 幂等：固定 style id，重复加载不重复注入；无状态、无副作用、无服务依赖。
window.__ModuleLoader__.load({ id: '@dsh-external/dsh-ui-performance', factory: (require) => {
	var module = { exports: {} };
	var exports = module.exports;
	Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });

	const inject = [];

	const STYLE_ID = 'dsh-ui-performance-css';

	const css = `
/* 规则一：设置面板遮罩禁用 backdrop-filter（毛玻璃 → 纯色半透明，背景色保留）。
   基础与皮肤模式均生效；皮肤模式下面板本体另有 blur（见规则二）。 */
[role="presentation"]:has(> [role="dialog"][aria-modal="true"] > nav) > [aria-hidden="true"] {
	backdrop-filter: none !important;
}

/* 规则二：设置面板本体禁用 backdrop-filter。
   原 maid-atelier 皮肤（已删）曾给面板本体加 blur(6px) saturate(0.9)；基础模式下面板无该属性，规则为无害 no-op。
   面板半透明底色保留，仅去掉最贵的模糊滤镜。 */
[role="presentation"] > [role="dialog"][aria-modal="true"]:has(> nav) {
	backdrop-filter: none !important;
}

/* 规则三：设置面板随视口自适应放大（原固定 800x800）。
   依据：.VOzbGW_panel{width:800px;max-width:calc(100vw - 48px);height:min(800px,100vh - 48px)}，
   其设计稿注释为 1080x700。clamp + max-* 双保险：任意分辨率不溢出，小窗口自动收缩。 */
[role="presentation"] > [role="dialog"][aria-modal="true"]:has(> nav) {
	width: clamp(800px, 80vw, 1240px) !important;
	max-width: calc(100vw - 48px) !important;
	height: clamp(720px, 82vh, 920px) !important;
	max-height: calc(100vh - 48px) !important;
}

/* 规则四：内容区宽度上限随面板适配（避免放大面板后内容仍挤在窄列）。
   依据：插件配置分区 .pbvGtq_section{max-width:760px}；插件清单 .qSYn7G_section{max-width:760px}；
   桌面设置 .dshDesktopSettings{width:min(100%,880px)}（本工作区自有类，稳定）。
   上游 hash 类名（qSYn7G/pbvGtq）随上游重建可能变化：规则静默失效回退原样，属可接受退化。 */
[role="dialog"][aria-modal="true"] .qSYn7G_section,
[role="dialog"][aria-modal="true"] .pbvGtq_section {
	max-width: none !important;
}
[role="dialog"][aria-modal="true"] .dshDesktopSettings {
	width: min(100%, 1040px) !important;
}

/* 规则五：插件清单卡片栅格自适应列数（原固定 2 列）。
   窄面板自动 2 列、宽面板 3~4 列；minmax(280px,1fr) 保证卡片最小宽度不被挤压。 */
[role="dialog"][aria-modal="true"] .qSYn7G_cards {
	grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)) !important;
}

/* 规则六：模型分区与 Agent 预设分区宽度上限适配（消除放大面板后右侧的灰色空区）。
   依据：.zGbnIq_section{max-width:720px}（ui-settings-models）；
   .rtSEdW_section{max-width:720px}（ui-agent-preset，其卡片栅格本为 auto-fill，放宽后自动增列）。
   上游 hash 类名失效时静默回退原样。 */
[role="dialog"][aria-modal="true"] .zGbnIq_section,
[role="dialog"][aria-modal="true"] .rtSEdW_section {
	max-width: none !important;
}

/* 规则七：插件清单卡片渲染节流。清单含上百个 Loader 条目，首次挂载全量渲染是
   「打开延迟」的主要成本；content-visibility:auto 跳过屏外卡片渲染，
   contain-intrinsic-size 提供高度估计，滚入视口时实测替换。 */
[role="dialog"][aria-modal="true"] .qSYn7G_card {
	content-visibility: auto;
	contain-intrinsic-size: auto 76px;
}

/* 规则八：第三方 dsh-better-sidebar 设置分区（导航标签"侧边栏"）宽度上限适配。
   依据：._2vuxea_section{width:100%;max-width:760px}（dsh-better-sidebar/lib/client.js，第三方包）。
   第三方类名随其版本变化时规则静默失效回退原样。 */
[role="dialog"][aria-modal="true"] ._2vuxea_section {
	max-width: none !important;
}

/* Rule 9 (dsh typing-lag fix 2026-09-16 (row render skip)): the conversation tree has no DOM virtualization,
   so under software raster every streamed token relayouts and repaints the
   whole message list. content-visibility:auto lets the browser skip the
   offscreen rows; contain-intrinsic-size remembers the last rendered height
   so the scrollbar does not jump after the first pass. Remove this block to
   restore the previous rendering behaviour. */
[data-chat-anchor-key] {
	content-visibility: auto;
	contain-intrinsic-size: auto 240px;
}

/* Rule 10 (dsh typing-lag fix 2026-09-17 (native composer text)): the composer textarea is
   rendered FULLY TRANSPARENT by the kernel (color:#0000 ; -webkit-text-fill-color:transparent
   in ui-conversation InputBar.module.css) and the glyphs you see are painted by a React
   backdrop overlay (div[data-input-backdrop]) built from the draft on every keystroke.
   Consequence: a typed character can only appear after input event -> input state machine ->
   store -> React commit -> layout -> paint of that overlay, and any main-thread contention in
   that window (e.g. dsh-client-connection validating every websocket frame, measured 48-61ms
   long tasks) delays what you see -- the "typing shows half a beat late" symptom. Chinese IME
   composition is hit twice, because the native composition string is transparent too.
   Fix: let the TEXTAREA paint its own text again (native, same frame as the input event) and
   keep the overlay only for decorations, raised above the textarea. Decorations keep their own
   colors (hlToken / textRef / chip / hint / icon rules), because the parent's transparent color
   only affects runs that have no color rule of their own. Selectors are structural (data
   attributes) so an upstream rebuild cannot silently void them; the :not(:disabled) suffix keeps the
   old transparent look for the inert workspace-trigger state. Remove this block to restore the
   previous rendering behaviour. */
[data-input-scroll] textarea[data-phase]:not(:disabled),
[data-input-scroll] textarea:not(:disabled) {
	color: var(--dsw-alias-label-primary) !important;
	-webkit-text-fill-color: currentColor !important;
}

[data-input-backdrop] {
	z-index: 2;
	color: transparent !important;
}

/* Rule 11 (dsh scroll fix 2026-09-17 (scroll containment)): the conversation scrollport and the
   sticky composer seat sit in one large paint subtree with NO containment and no compositing
   hints anywhere in the product (audited 2026-09-17: will-change appears once in the whole
   client tree and only while dragging; translateZ(0) zero times; CSS contain only in
   better-sidebar/deliverables). Every scrolled frame can therefore invalidate a large area.
   contain:paint on the scrollport bounds invalidation to the scrollport box -- which
   overflow:hidden auto already clips, so nothing new is hidden -- and contain:layout on
   the composer seat isolates the sticky band's relayout. Deliberately NOT contain:paint on
   the seat: slot children may host dropdown layers that extend past it. Remove this block to
   restore the previous rendering behaviour. NOTE: never write backticks in this stylesheet --
   the whole CSS is a JS template literal and a backtick closes it early (caught twice by the
   syntax-integrity gate on 2026-09-17). */
[data-conversation-scroll] {
	contain: paint;
}

[data-composer-seat] {
	contain: layout;
}
`;

	function ensureCss() {
		if (typeof document === 'undefined') return;
		if (document.getElementById(STYLE_ID)) return;
		const tag = document.createElement('style');
		tag.id = STYLE_ID;
		tag.textContent = css;
		document.head.appendChild(tag);
	}

	function apply() {
		ensureCss();
	}

	module.exports = { inject, apply };
	return module.exports;
} });
