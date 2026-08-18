/**
 * @dsh-external/dsh-file-explorer — client 侧
 *
 * 右侧文件浏览器：占用 details slot（双 tab：文件 / 详情）。
 * 与 host 通过 /file-explorer/api（本机 trusted JSON RPC）通信。
 * 文件树 + 代码查看（按扩展名简易高亮）。
 */
window.__ModuleLoader__.load({
	id: "@dsh-external/dsh-file-explorer",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		var react = require("react");
		var createElement = react.createElement;
		var useState = react.useState, useEffect = react.useEffect;
		const inject = ["slots"];

		// ═══════════════ host API ═══════════════

		function callApi(method, args) {
			return fetch("/file-explorer/api", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ method: method, args: args || {} }),
			}).then(function (r) { return r.json(); }).then(function (r) {
				if (r && r.ok) return r.data;
				throw new Error((r && r.error) || "请求失败");
			});
		}

		// ═══════════════ 简易代码高亮 ═══════════════

		var KEYWORDS = {
			js: "var|let|const|function|return|if|else|for|while|do|switch|case|break|continue|new|class|extends|super|this|typeof|instanceof|in|of|try|catch|finally|throw|async|await|yield|import|export|from|default|null|undefined|true|false|void|delete|static|get|set|interface|type|enum|implements|public|private|protected|readonly|abstract|namespace|declare|satisfies|keyof|infer|is|as|asserts|using|accessor|override",
			py: "def|class|return|if|elif|else|for|while|try|except|finally|with|as|import|from|yield|lambda|pass|break|continue|raise|global|nonlocal|assert|async|await|del|in|is|not|and|or|True|False|None|self|match|case",
			go: "package|import|func|var|const|type|struct|interface|map|chan|go|defer|return|if|else|for|range|switch|case|break|continue|select|fallthrough|default|true|false|nil|iota|new|make|len|cap|append|copy|delete|panic|recover|error",
			rs: "fn|let|mut|const|struct|enum|trait|impl|mod|use|pub|crate|self|super|match|if|else|for|while|loop|break|continue|return|async|await|move|ref|where|type|dyn|static|unsafe|extern|true|false|Option|Result|Some|None|Ok|Err|vec!|println!|macro_rules!",
			sh: "if|then|else|elif|fi|for|while|do|done|case|esac|function|return|exit|export|local|read|echo|printf|set|unset|shift|source|alias|declare|typeset|test|exec|eval|trap|wait|cd|pwd|ls|cat|grep|sed|awk",
			ps1: "function|param|if|else|elseif|for|foreach|while|switch|break|continue|return|try|catch|finally|throw|import|export|using|class|enum|new|begin|process|end|filter|trap|$|@|%|Write-Host|Write-Output|Get-Item|Set-Content|Test-Path|Join-Path|New-Item|Remove-Item|Copy-Item|Move-Item|Get-ChildItem|Get-Content|Start-Process|Stop-Process|ForEach-Object|Where-Object|Select-Object",
			json: "true|false|null",
			html: "html|head|body|div|span|p|a|img|ul|li|ol|table|tr|td|th|button|input|form|script|style|link|meta|title|h1|h2|h3|h4|h5|h6|section|article|header|footer|nav|main|aside|canvas|video|audio|iframe|pre|code|blockquote|em|strong|small|label|select|option|textarea|svg|path|viewBox|className|href|src|alt|id|class|style|type|value|name|onClick|onChange|placeholder|disabled|checked|defaultValue",
			md: "",
			css: "body|div|html|margin|padding|color|background|display|flex|position|absolute|relative|fixed|top|left|right|bottom|width|height|border|border-radius|box-shadow|font|font-size|font-weight|line-height|text-align|overflow|z-index|opacity|transition|transform|content|cursor|gap|align|justify|grid|media|hover|active|focus|visited|first-child|last-child|nth-child|calc|var|import|keyframes|animation"
		};
		var STRING_RE = /("(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|`(?:[^`\\]|\\.)*`|#[^\n]*|\/\/[^\n]*|\/\*[\s\S]*?\*\/)/g;
		var KW_RE = /[A-Za-z_$][A-Za-z0-9_$]*/g;

		function highlight(code, kind) {
			var kw = KEYWORDS[kind] || "";
			var tokens = [];
			var last = 0;
			var re = new RegExp("(" + STRING_RE.source + ")");
			var m;
			STRING_RE.lastIndex = 0;
			re.lastIndex = 0;
			// 字符串/注释/正则先分片
			var parts = [];
			var pLast = 0;
			STRING_RE.lastIndex = 0;
			while ((m = STRING_RE.exec(code)) !== null) {
				if (m.index > pLast) parts.push({ t: "code", v: code.slice(pLast, m.index) });
				var val = m[0];
				var typ = val.startsWith("#") || val.startsWith("//") || val.startsWith("/*") ? "comment" : "string";
				parts.push({ t: typ, v: val });
				pLast = m.index + val.length;
			}
			if (pLast < code.length) parts.push({ t: "code", v: code.slice(pLast) });
			var out = [];
			for (var i = 0; i < parts.length; i++) {
				var part = parts[i];
				if (part.t !== "code") {
					out.push(createElement("span", { key: out.length, style: part.t === "comment" ? { color: "#6a9955" } : { color: "#ce9178" } }, part.v));
					continue;
				}
				KW_RE.lastIndex = 0;
				var kwLast = 0;
				var mm;
				while ((mm = KW_RE.exec(part.v)) !== null) {
					if (mm.index > kwLast) out.push(createElement("span", { key: out.length }, part.v.slice(kwLast, mm.index)));
					var word = mm[0];
					if (kw.split("|").indexOf(word) !== -1) {
						out.push(createElement("span", { key: out.length, style: { color: "#569cd6" } }, word));
					} else if (/^\d+(\.\d+)?$/.test(word)) {
						out.push(createElement("span", { key: out.length, style: { color: "#b5cea8" } }, word));
					} else {
						out.push(createElement("span", { key: out.length }, word));
					}
					kwLast = mm.index + word.length;
				}
				if (kwLast < part.v.length) out.push(createElement("span", { key: out.length }, part.v.slice(kwLast)));
			}
			return out;
		}

		// ═══════════════ 文件浏览器面板 ═══════════════

		function FileExplorerPanel() {
			var _s = useState("");
			var path = _s[0], setPath = _s[1];
			window.__fe_curPath = path;
			var _s2 = useState(null);
			var tree = _s2[0], setTree = _s2[1];
			var _s3 = useState(null);
			var openedDirs = _s3[0], setOpenedDirs = _s3[1];
			var _s4 = useState(null);
			var file = _s4[0], setFile = _s4[1];
			var _s5 = useState(null);
			var error = _s5[0], setError = _s5[1];
			var _s6 = useState(false);
			var busy = _s6[0], setBusy = _s6[1];

			useEffect(function () {
				// 鼠标侧键：下键(3)=返回文件上一级；上键(4)=仅拦截默认导航
				function handler(e) {
					var cur = window.__fe_curPath || path || "";
					if (e.button === 3) {
						e.preventDefault();
						try {
							var idx = cur.replace(/\\/g, "/").lastIndexOf("/");
							// 盘根（如 D:\）不再上跳；否则切到上一级
							if (idx > 0 && !/^[A-Za-z]:[\\/]$/.test(cur)) navigate(cur.slice(0, idx));
						} catch (err) { /* 忽略：侧键处理失败不影响界面 */ }
					} else if (e.button === 4) {
						e.preventDefault();
					}
				}
				["mousedown", "mouseup", "auxclick"].forEach(function (t) { window.addEventListener(t, handler, true); });
				return function () { ["mousedown", "mouseup", "auxclick"].forEach(function (t) { window.removeEventListener(t, handler, true); }); };
			}, [path]);

			useEffect(function () {
				// 初始：尝试会话 cwd，失败回退 ~/（提示手动输入）
				callApi("session-cwd").then(function (d) {
					if (d && d.cwd) {
						setPath(d.cwd);
						loadDir(d.cwd);
					} else {
						setPath("");
						loadDir("~");
					}
				}).catch(function () { loadDir("~"); });
			}, []);

			function loadDir(dir) {
				setBusy(true);
				setError(null);
				callApi("list-dir", { path: dir }).then(function (d) {
					setTree(d);
					setPath(d.path);
					setOpenedDirs({});
					setBusy(false);
				}).catch(function (e) {
					setError((e && e.message) || String(e));
					setBusy(false);
				});
			}

			function openFile(f) {
				if (f.isDir) { toggleDirFull(f.path); return; }
				setBusy(true);
				setError(null);
				callApi("read-file", { path: f.path }).then(function (d) {
					setFile(d);
					setBusy(false);
				}).catch(function (e) {
					setError((e && e.message) || String(e));
					setBusy(false);
				});
			}

			function navigate(dir) {
				setBusy(true);
				setError(null);
				callApi("list-dir", { path: dir }).then(function (d) {
					setTree(d);
					setPath(d.path);
					setOpenedDirs({});
					setBusy(false);
				}).catch(function (e) {
					setError((e && e.message) || String(e));
					setBusy(false);
				});
			}

			var rowStyle = { display: "flex", alignItems: "center", gap: 6, padding: "2px 8px", cursor: "pointer", borderRadius: 4, fontSize: 12, whiteSpace: "nowrap" };
			var dirIcon = { color: "#d4920a", fontSize: 11 };
			var fileIcon = { color: "#6b7686", fontSize: 11 };

			function renderRow(e, depth) {
				var isDir = e.isDir;
				var expanded = openedDirs && openedDirs[e.path];
				return createElement("div", { key: e.path },
					createElement("div", {
						style: Object.assign({}, rowStyle, { paddingLeft: 8 + depth * 14, background: file && file.path === e.path ? "rgba(86,156,214,0.15)" : "transparent" }),
						onClick: function () { openFile(e); },
						title: e.path
					},
						createElement("span", { style: isDir ? dirIcon : fileIcon }, isDir ? (expanded ? "▾" : "▸") : "·"),
						createElement("span", { style: { color: isDir ? "#d7ba7d" : "#d4d4d4", overflow: "hidden", textOverflow: "ellipsis" } }, e.name)
					),
					isDir && expanded && treeEntriesOf(e.path).map(function (c) { return renderRow(c, depth + 1); })
				);
			}

			// 子目录内容缓存：{ dirPath: entries[] }
			var _dirCache = useState({});
			var dirCache = _dirCache[0], setDirCache = _dirCache[1];

			function treeEntriesOf(dirPath) {
				return (dirCache && dirCache[dirPath]) || [];
			}

			function toggleDirFull(dir) {
				var wasOpen = !!(openedDirs && openedDirs[dir]);
				var next = Object.assign({}, openedDirs || {});
				if (!wasOpen) {
					next[dir] = true;
					setOpenedDirs(next);
					setBusy(true);
					callApi("list-dir", { path: dir }).then(function (d) {
						setDirCache(Object.assign({}, dirCache, { [dir]: d.entries }));
						setBusy(false);
					}).catch(function (e) {
						setError((e && e.message) || String(e));
						setBusy(false);
					});
				} else {
					delete next[dir];
					setOpenedDirs(next);
				}
			}

			function goUp() {
				if (!path) return;
				var idx = path.replace(/\\/g, "/").lastIndexOf("/");
				if (idx <= 0) return;
				navigate(path.slice(0, idx));
			}

			var inputStyle = { width: "100%", boxSizing: "border-box", padding: "4px 8px", borderRadius: 6, border: "1px solid rgba(127,127,127,0.3)", background: "rgba(127,127,127,0.08)", color: "#d4d4d4", fontSize: 12, outline: "none" };
			var btnStyle = { padding: "3px 10px", borderRadius: 6, border: "1px solid rgba(127,127,127,0.3)", background: "transparent", color: "#d4d4d4", cursor: "pointer", fontSize: 12 };
			var fmtSize = function (n) { return n > 1048576 ? (n / 1048576).toFixed(1) + " MB" : n > 1024 ? (n / 1024).toFixed(1) + " KB" : n + " B"; };

			return createElement("div", { style: { display: "flex", flexDirection: "column", height: "100%" } },
				createElement("div", { style: { display: "flex", gap: 6, padding: "8px 10px 4px" } },
					createElement("input", {
						style: inputStyle,
						value: path,
						placeholder: "输入目录（如 ~/projects 或 D:\\...）",
						onChange: function (ev) { setPath(ev.target.value); },
						onKeyDown: function (ev) { if (ev.key === "Enter" && ev.target.value) navigate(ev.target.value); }
					}),
					createElement("button", { style: btnStyle, onClick: goUp, title: "上一级" }, "↑"),
					createElement("button", { style: btnStyle, onClick: function () { navigate(path); }, title: "刷新" }, "↻"),
					createElement("button", { style: btnStyle, onClick: function () { loadDir("~"); }, title: "用户主目录" }, "⌂")
				),
				error && createElement("div", { style: { padding: "4px 10px", color: "#f48771", fontSize: 12 } }, error),
				busy && createElement("div", { style: { padding: "4px 10px", color: "#888", fontSize: 11 } }, "加载中…"),
				createElement("div", { style: { flex: 1, overflowY: "auto", padding: "4px 0" } },
					!tree && !busy && !error && createElement("div", { style: { padding: "8px 10px", color: "#888", fontSize: 12 } }, "加载目录…"),
					tree && tree.entries.map(function (e) { return renderRow(e, 0); })
				),
				file && createElement("div", { style: { borderTop: "1px solid rgba(127,127,127,0.2)", display: "flex", flexDirection: "column", height: "50%" } },
					createElement("div", { style: { display: "flex", alignItems: "center", gap: 6, padding: "4px 10px", background: "rgba(127,127,127,0.1)" } },
						createElement("span", { style: { fontSize: 11, color: "#9cdcfe", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } }, file.path),
						createElement("span", { style: { fontSize: 10, color: "#888", marginLeft: "auto" } }, fmtSize(file.size)),
						createElement("button", { style: Object.assign({}, btnStyle, { padding: "1px 6px" }), onClick: function () { setFile(null); } }, "✕")
					),
					createElement("pre", { style: { flex: 1, overflow: "auto", margin: 0, padding: "8px 10px", fontSize: 11.5, lineHeight: 1.5, color: "#d4d4d4", fontFamily: "Consolas, 'Courier New', monospace" } },
						highlight(file.content, file.path.split(".").pop().toLowerCase().replace(/^d$/i, "ts").toLowerCase())
					)
				)
			);
		}

		// ═══════════════ details 双 tab 壳 ═══════════════

		function DetailsShell() {
			var _t = useState("files");
			var tab = _t[0], setTab = _t[1];
			var tabStyle = { flex: 1, padding: "6px 0", fontSize: 12, cursor: "pointer", border: "none", background: "transparent", color: "#888" };
			var tabActive = { flex: 1, padding: "6px 0", fontSize: 12, cursor: "pointer", border: "none", background: "transparent", color: "#fff", borderBottom: "2px solid #3794ff" };
			return createElement("div", { style: { display: "flex", flexDirection: "column", height: "100%" } },
				createElement("div", { style: { display: "flex", borderBottom: "1px solid rgba(127,127,127,0.25)", padding: "0 10px" } },
					createElement("button", { style: tab === "files" ? tabActive : tabStyle, onClick: function () { setTab("files"); } }, "文件"),
					createElement("button", { style: tab === "info" ? tabActive : tabStyle, onClick: function () { setTab("info"); } }, "详情")
				),
				createElement("div", { style: { flex: 1, overflow: "hidden" } },
					tab === "files" ? createElement(FileExplorerPanel, {}) :
						createElement("div", { style: { padding: 12, fontSize: 12, color: "#888", lineHeight: 1.8 } },
							createElement("div", { style: { color: "#d4d4d4", marginBottom: 8 } }, "文件浏览器详情"),
							"当前显示本机文件浏览与代码查看。",
							createElement("br", {}),
							"根目录限制在用户主目录内，仅本机可访问。"
						)
				)
			);
		}

		// ═══════════════ apply ═══════════════

		function apply(ctx) {
			try {
				// 鼠标侧键（back/forward）在 SPA 中会触发历史导航破坏会话视图：全局拦截默认行为
				var sideNavGuard = function (e) {
					if (e.button === 3 || e.button === 4) e.preventDefault();
				};
				["mousedown", "mouseup", "auxclick"].forEach(function (t) {
					window.addEventListener(t, sideNavGuard, true);
				});
				ctx.effect(function () {
					return ctx.slots.inject("details", function () {
						try {
							return ctx.slots.register({
								name: "details",
								kind: "single",
								scope: "session",
								priority: -1
							}, DetailsShell);
						} catch (e) {
							console.warn("[dsh-file-explorer] details slot unavailable, skipped:", e && e.message || e);
							return null;
						}
					});
				}, "@dsh-external/dsh-file-explorer: details panel");
				console.log("[dsh-file-explorer] ready, details panel registered");
			} catch (e) {
				console.warn("[dsh-file-explorer] apply failed:", e && e.message || e);
			}
		}

		exports.inject = inject;
		exports.apply = apply;
		return module.exports;
	}
});

//# sourceMappingURL=client.js.map