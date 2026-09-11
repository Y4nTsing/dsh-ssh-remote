/* dsh-plugin-ssh-remote-panel — client half.
 *
 * Registers one official Conversation View ("SSH 终端") through the
 * conversation.view slot: the app renders the tab, manages its lifecycle
 * (unmount on conversation switch, fresh remount on return), and the
 * component resolves the CURRENT session from standard session-scoped props
 * — no breadcrumb-title matching, no DOM injection, nothing runs until the
 * user opens the tab.
 *
 * The view body hosts the standalone panel page
 * (/ssh-remote-panel/?session=<id>) in an iframe; a session without
 * ssh-remote history gets a light placeholder. When the session id cannot
 * be resolved the iframe falls back to the unscoped operator view (history
 * stays readable) and a one-shot diag line reports the props it actually
 * received, so field mismatches are visible in panel-debug.log. */
window.__ModuleLoader__.load({
	id: "dsh-plugin-ssh-remote-panel",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		const React = require("react");

		var probeCache = new Map();

		function extractSessionId(props) {
			if (props != null && typeof props.sessionId === "string" && props.sessionId !== "") return props.sessionId;
			var s = null;
			try {
				s = typeof props.useSession === "function" ? props.useSession(function (v) { return v }) : null;
			} catch (_) {}
			if (s == null || typeof s !== "object") return "";
			if (typeof s.id === "string" && s.id !== "") return s.id;
			if (s.header != null && typeof s.header.id === "string" && s.header.id !== "") return s.header.id;
			if (typeof s.sessionId === "string" && s.sessionId !== "") return s.sessionId;
			return "";
		}

		function reportDiag(kind, data) {
			try {
				fetch("/ssh-remote-panel/diag", {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify(Object.assign({ kind: kind }, data)),
				}).catch(function () {});
			} catch (_) {}
		}

		function probeSession(sessionId) {
			var cached = probeCache.get(sessionId);
			var now = Date.now();
			if (cached !== undefined && now - cached.at < 15000) return Promise.resolve(cached.ok);
			return fetch("/ssh-remote-panel/sessions?agent=" + encodeURIComponent(sessionId), { cache: "no-store" })
				.then(function (r) { return r.json() })
				.then(function (data) {
					var ok = !!(data && data.currentIsSsh === true);
					probeCache.set(sessionId, { at: now, ok: ok });
					return ok;
				})
				.catch(function () { return false });
		}

		function SshTerminalView(props) {
			var sessionId = extractSessionId(props);
			var state = React.useState({ loading: sessionId !== "", ok: false });
			var value = state[0];
			var setValue = state[1];
			React.useEffect(function () {
				if (sessionId === "") {
					setValue({ loading: false, ok: false, noId: true });
					return undefined;
				}
				var alive = true;
				setValue({ loading: true, ok: false });
				probeSession(sessionId).then(function (ok) {
					if (alive) setValue({ loading: false, ok: ok });
				});
				return function () { alive = false };
			}, [sessionId]);
			React.useEffect(function () {
				// One-shot structural report: exact props/ids this build hands a
				// conversation.view entry (written to panel-debug.log).
				var keys = [];
				try { keys = Object.keys(props || {}) } catch (_) {}
				reportDiag("view", {
					propsKeys: keys.join(","),
					resolvedId: sessionId,
					probe: value.loading ? "loading" : String(value.ok),
				});
			}, [sessionId]);
			if (value.loading) {
				return React.createElement("div", {
					style: { padding: "32px", textAlign: "center", color: "var(--dsw-alias-label-secondary)", fontSize: "13px" },
				}, "…");
			}
			if (!value.ok) {
				if (value.noId === true) {
					// Session id unresolvable in this build: show the full
					// operator view instead of blocking the user.
					return React.createElement("iframe", {
						src: "/ssh-remote-panel/",
						title: "SSH 终端",
						style: { width: "100%", height: "100%", minHeight: "420px", border: "0", display: "block", borderRadius: "8px" },
					});
				}
				return React.createElement("div", {
					style: {
						padding: "40px 24px", textAlign: "center",
						color: "var(--dsw-alias-label-secondary)", fontSize: "13px", lineHeight: 1.8,
					},
				},
					React.createElement("div", { style: { fontSize: "15px", color: "var(--dsw-alias-label-primary)", marginBottom: "6px" } }, "此会话没有 SSH 远程记录"),
					React.createElement("div", null, "ssh-remote 预设的会话会在这里显示终端回放；历史会话可从左侧打开对应对话查看。"));
			}
			return React.createElement("iframe", {
				src: "/ssh-remote-panel/?session=" + encodeURIComponent(sessionId),
				title: "SSH 终端",
				style: { width: "100%", height: "100%", minHeight: "420px", border: "0", display: "block", borderRadius: "8px" },
			});
		}

		function apply(ctx) {
			var slots = ctx.get("slots");
			if (slots === undefined) return;
			slots.inject("conversation.view", function () {
				return slots.register(
					{ name: "conversation.view", id: "ssh-terminal", order: 20, label: "SSH 终端" },
					function (props) { return React.createElement(SshTerminalView, props) },
				);
			});
		}

		exports.apply = apply;
		exports.inject = ["slots"];
		return module.exports;
	},
});
