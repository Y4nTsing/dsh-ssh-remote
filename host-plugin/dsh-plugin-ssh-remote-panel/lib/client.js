/* dsh-plugin-ssh-remote-panel — client half.
 *
 * STRICT per-conversation gating: the "SSH 终端" conversation view is
 * registered ONLY while the currently viewed session actually has ssh-remote
 * history. The view tab strip projects the slots ledger unconditionally
 * (ViewTab = {id,label}, no visibility predicate), so gating is done by
 * REGISTERING/UNREGISTERING the view entry dynamically:
 *
 *   SshViewGate  — a null-rendering entry in the session-scoped
 *                  conversation.session.header.utilities slot; it reads the
 *                  current session id from standard props (sessionId /
 *                  useSession), probes the backend once per session
 *                  (journal existence = durable proof), and keeps the
 *                  conversation.view entry registered exactly while that
 *                  session qualifies. Unmounting on a conversation switch
 *                  disposes the registration, so the tab follows the
 *                  session automatically.
 *
 *   SshTerminalView — the view body: the standalone panel page in an iframe
 *                  (?session=<id> pins the conversation's journal). It only
 *                  renders after the gate confirmed the session. */
window.__ModuleLoader__.load({
	id: "dsh-plugin-ssh-remote-panel",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		const React = require("react");

		var probeCache = new Map();
		var slotsRef = null;

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

		/** Journal existence for this exact session id = it ran ssh-remote. */
		function probeSession(sessionId) {
			var cached = probeCache.get(sessionId);
			var now = Date.now();
			if (cached !== undefined && now - cached.at < 30000) return Promise.resolve(cached.ok);
			return fetch("/ssh-remote-panel/sessions?agent=" + encodeURIComponent(sessionId), { cache: "no-store" })
				.then(function (r) { return r.json() })
				.then(function (data) {
					var ok = !!(data && data.currentIsSsh === true);
					probeCache.set(sessionId, { at: now, ok: ok });
					return ok;
				})
				.catch(function () { return false });
		}

		/* ---------- the view body (renders only when the gate passed) ----- */

		function SshTerminalView(props) {
			var sessionId = extractSessionId(props);
			return React.createElement("iframe", {
				src: sessionId !== ""
					? "/ssh-remote-panel/?session=" + encodeURIComponent(sessionId)
					: "/ssh-remote-panel/",
				title: "SSH 终端",
				style: { width: "100%", height: "100%", minHeight: "420px", border: "0", display: "block", borderRadius: "8px" },
			});
		}

		/* ---------- the gate (drives the tab's existence) ------------------ */

		function SshViewGate(props) {
			var sessionId = extractSessionId(props);
			var state = React.useState(false);
			var hasSsh = state[0];
			var setHasSsh = state[1];
			React.useEffect(function () {
				if (sessionId === "") {
					setHasSsh(false);
					return undefined;
				}
				var alive = true;
				probeSession(sessionId).then(function (ok) {
					if (alive) setHasSsh(ok);
				});
				return function () { alive = false };
			}, [sessionId]);
			React.useEffect(function () {
				// Register the view exactly while the viewed session qualifies;
				// the reactive slots ledger adds/removes the tab immediately.
				if (!hasSsh || slotsRef === undefined) return undefined;
				return slotsRef.register(
					{ name: "conversation.view", id: "ssh-terminal", order: 20, label: "SSH 终端" },
					function (vprops) { return React.createElement(SshTerminalView, vprops) },
				);
			}, [hasSsh]);
			React.useEffect(function () {
				reportDiag("gate", { sessionId: sessionId, hasSsh: String(hasSsh) });
			}, [sessionId, hasSsh]);
			return null;
		}

		function apply(ctx) {
			var slots = ctx.get("slots");
			if (slots === undefined) return;
			slotsRef = slots;
			slots.inject("conversation.session.header.utilities", function () {
				return slots.register(
					{ name: "conversation.session.header.utilities", id: "ssh-view-gate", order: 999 },
					function (props) { return React.createElement(SshViewGate, props) },
				);
			});
		}

		exports.apply = apply;
		exports.inject = ["slots"];
		return module.exports;
	},
});
