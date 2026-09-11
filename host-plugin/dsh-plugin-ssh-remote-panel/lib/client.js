/* dsh-plugin-ssh-remote-panel — client half.
 *
 * Registers one official Conversation View ("SSH 终端") through the
 * conversation.view slot: the app itself renders the tab, manages its
 * lifecycle (unmount on conversation switch, fresh remount on return), and
 * hands the component the CURRENT session through the standard session-scoped
 * slot props — no breadcrumb-title matching, no DOM injection, nothing runs
 * until the user opens the tab.
 *
 * The view body is the battle-tested standalone panel page
 * (/ssh-remote-panel/?session=<id>) hosted in an iframe: same terminal,
 * jobs view, and session picker, scoped by the host backend. A session
 * without ssh-remote history gets a light placeholder instead. */
window.__ModuleLoader__.load({
	id: "dsh-plugin-ssh-remote-panel",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		const React = require("react");

		var lastProbeBySession = new Map();

		function probeSession(sessionId) {
			var cached = lastProbeBySession.get(sessionId);
			var now = Date.now();
			if (cached !== undefined && now - cached.at < 15000) {
				return Promise.resolve(cached.ok);
			}
			return fetch("/ssh-remote-panel/sessions?agent=" + encodeURIComponent(sessionId), { cache: "no-store" })
				.then(function (r) { return r.json() })
				.then(function (data) {
					var ok = !!(data && data.currentIsSsh === true);
					lastProbeBySession.set(sessionId, { at: now, ok: ok });
					return ok;
				})
				.catch(function () { return false });
		}

		function SshTerminalView(props) {
			var session = typeof props.useSession === "function" ? props.useSession(function (s) { return s }) : null;
			var sessionId = session && typeof session.id === "string" ? session.id : "";
			var state = React.useState({ loading: sessionId !== "", ok: false });
			var value = state[0];
			var setValue = state[1];
			React.useEffect(function () {
				if (sessionId === "") {
					setValue({ loading: false, ok: false });
					return undefined;
				}
				var alive = true;
				setValue({ loading: true, ok: false });
				probeSession(sessionId).then(function (ok) {
					if (alive) setValue({ loading: false, ok: ok });
				});
				return function () { alive = false };
			}, [sessionId]);
			if (value.loading) {
				return React.createElement("div", {
					style: { padding: "32px", textAlign: "center", color: "var(--dsw-alias-label-secondary)", fontSize: "13px" },
				}, "…");
			}
			if (!value.ok) {
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
