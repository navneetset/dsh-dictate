/**
 * Mic button injected into `conversation.input.left` — the left end of the
 * composer tool row. Left-click toggles hands-free dictation (or holds for
 * push-to-talk), right-click opens the settings popover, Ctrl+M toggles when
 * the hotkey pref is on. Transcript text lands in the composer draft through
 * `inputActions.setDraft`, preserving whatever the user already typed.
 */
import React, { useCallback, useEffect, useRef, useState } from "react";
import { controller } from "./controller";
import { onPrefsChange, prefs, updatePrefs } from "./prefs";

const MODELS = [
	"openai/gpt-4o-mini-transcribe",
	"openai/gpt-4o-transcribe",
	"openai/whisper-large-v3",
];

const LANGUAGES = [
	["", "Auto-detect"],
	["en", "English"],
	["nl", "Nederlands"],
	["de", "Deutsch"],
	["fr", "Français"],
	["es", "Español"],
	["pt", "Português"],
	["it", "Italiano"],
];

let stylesInjected = false;
function injectStyles() {
	if (stylesInjected || typeof document === "undefined") return;
	stylesInjected = true;
	const style = document.createElement("style");
	style.textContent = `
.dsh-dictate-wrap { position: relative; display: inline-flex; align-items: center; }
.dsh-dictate-btn {
	height: 26px; width: 26px; padding: 0; border: none; border-radius: 6px;
	display: inline-flex; align-items: center; justify-content: center;
	background: transparent; color: inherit; opacity: .72; cursor: pointer;
}
.dsh-dictate-btn:hover { opacity: 1; background: color-mix(in srgb, CanvasText 10%, transparent); }
.dsh-dictate-btn svg { display: block; }
.dsh-dictate-btn.rec { opacity: 1; color: #d64545; animation: dsh-dictate-pulse 1.2s ease-in-out infinite; }
.dsh-dictate-btn.busy { opacity: 1; animation: dsh-dictate-pulse 1.2s ease-in-out infinite; }
.dsh-dictate-btn.err { opacity: 1; color: #d64545; }
@keyframes dsh-dictate-pulse { 0%, 100% { opacity: 1; } 50% { opacity: .4; } }
.dsh-dictate-menu {
	position: absolute; bottom: calc(100% + 10px); left: 0; width: 250px;
	padding: 10px; border-radius: 10px; z-index: 60;
	background: Canvas; color: CanvasText; font-size: 12px;
	border: 1px solid color-mix(in srgb, CanvasText 15%, transparent);
	box-shadow: 0 8px 30px color-mix(in srgb, CanvasText 25%, transparent);
	display: flex; flex-direction: column; gap: 8px;
}
.dsh-dictate-menu label { display: flex; flex-direction: column; gap: 3px; font-weight: 600; }
.dsh-dictate-menu select, .dsh-dictate-menu input[type="text"] {
	font: inherit; font-weight: 400; padding: 4px 6px; border-radius: 6px;
	border: 1px solid color-mix(in srgb, CanvasText 25%, transparent);
	background: transparent; color: inherit;
}
.dsh-dictate-check { flex-direction: row !important; align-items: center; gap: 6px !important; }
.dsh-dictate-err { color: #d64545; font-weight: 400; overflow-wrap: anywhere; }
.dsh-dictate-hint { opacity: .65; font-weight: 400; }
`;
	document.head.appendChild(style);
}

export function MicButton(props) {
	const { useInput, inputActions } = props ?? {};
	const draft = typeof useInput === "function" ? useInput((s) => s?.draft) : undefined;

	const [state, setState] = useState(controller.state);
	const [menuOpen, setMenuOpen] = useState(false);
	const [, bumpPrefs] = useState(0);
	const lastKnown = useRef("");
	const wrote = useRef(null);
	const pttDown = useRef(false);
	const wrapRef = useRef(null);

	injectStyles();

	useEffect(() => controller.onChange(() => setState({ ...controller.state })), []);
	useEffect(() => onPrefsChange(() => bumpPrefs((v) => v + 1)), []);

	// Track the machine draft; when it diverges from what we last wrote, the
	// user typed — resync so inserts never clobber their edits.
	useEffect(() => {
		if (typeof draft === "string" && draft !== wrote.current) lastKnown.current = draft;
	}, [draft]);

	useEffect(() => {
		controller.inserter = (text) => {
			const current = lastKnown.current;
			const joiner = current && !/\s$/.test(current) ? " " : "";
			const next = current + joiner + text;
			lastKnown.current = next;
			wrote.current = next;
			try {
				inputActions?.setDraft?.(next);
			} catch (error) {
				console.warn("[dsh-dictate] setDraft failed:", error);
			}
		};
		return () => {
			controller.inserter = undefined;
		};
	}, [inputActions]);

	useEffect(() => {
		if (!prefs.hotkey) return;
		const onKey = (event) => {
			if (!event.ctrlKey || event.altKey || event.metaKey || event.shiftKey) return;
			if (event.key !== "m" && event.key !== "M") return;
			event.preventDefault();
			controller.toggle();
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [prefs.hotkey]);

	useEffect(() => {
		if (!menuOpen) return;
		const onDown = (event) => {
			if (wrapRef.current && event.target instanceof Node && !wrapRef.current.contains(event.target)) setMenuOpen(false);
		};
		document.addEventListener("pointerdown", onDown, true);
		return () => document.removeEventListener("pointerdown", onDown, true);
	}, [menuOpen]);

	const onPointerDown = useCallback((event) => {
		if (event.button !== 0 || prefs.mode !== "ptt") return;
		pttDown.current = true;
		void controller.start("ptt");
	}, []);
	const onPointerUp = useCallback(() => {
		if (!pttDown.current) return;
		pttDown.current = false;
		void controller.stop();
	}, []);
	const onClick = useCallback(() => {
		if (prefs.mode !== "ptt") controller.toggle();
	}, []);
	const onContextMenu = useCallback((event) => {
		event.preventDefault();
		setMenuOpen((open) => !open);
	}, []);

	const recording = state.phase === "recording";
	const busy = state.phase === "transcribing";
	const errored = state.phase === "error";
	const title = errored
		? `Dictation error: ${state.error ?? "unknown"} — click to retry`
		: recording
			? (state.mode === "ptt" ? "Release to transcribe" : "Recording — click to stop; right-click for settings")
			: busy
				? "Transcribing…"
				: prefs.mode === "ptt"
					? "Hold to dictate; right-click for settings"
					: "Click to dictate; right-click for settings (Ctrl+M)";

	return (
		<div className="dsh-dictate-wrap" ref={wrapRef}>
			<button
				type="button"
				aria-label="Dictate"
				title={title}
				className={"dsh-dictate-btn" + (recording ? " rec" : "") + (busy ? " busy" : "") + (errored ? " err" : "")}
				onPointerDown={onPointerDown}
				onPointerUp={onPointerUp}
				onPointerLeave={onPointerUp}
				onClick={onClick}
				onContextMenu={onContextMenu}
			>
				<svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
					<path d="M12 14a3 3 0 0 0 3-3V6a3 3 0 0 0-6 0v5a3 3 0 0 0 3 3Z" />
					<path d="M19 11a1 1 0 1 0-2 0 5 5 0 0 1-10 0 1 1 0 1 0-2 0 7 7 0 0 0 6 6.93V20a1 1 0 1 0 2 0v-2.07A7 7 0 0 0 19 11Z" />
				</svg>
			</button>
			{menuOpen && (
				<div className="dsh-dictate-menu" onPointerDown={(event) => event.stopPropagation()}>
					<label>
						Mode
						<select value={prefs.mode} onChange={(event) => updatePrefs({ mode: event.target.value })}>
							<option value="handsfree">Hands-free (auto segments)</option>
							<option value="ptt">Push-to-talk (hold)</option>
						</select>
					</label>
					<label>
						Model
						<input type="text" list="dsh-dictate-models" value={prefs.model} spellCheck={false} onChange={(event) => updatePrefs({ model: event.target.value })} />
						<datalist id="dsh-dictate-models">
							{MODELS.map((model) => <option key={model} value={model} />)}
						</datalist>
					</label>
					<label>
						Language
						<select value={prefs.language} onChange={(event) => updatePrefs({ language: event.target.value })}>
							{LANGUAGES.map(([code, label]) => <option key={code || "auto"} value={code}>{label}</option>)}
						</select>
					</label>
					<label className="dsh-dictate-check">
						<input type="checkbox" checked={prefs.hotkey} onChange={(event) => updatePrefs({ hotkey: event.target.checked })} />
						Ctrl+M toggles dictation
					</label>
					{errored
						? <div className="dsh-dictate-err">{state.error}</div>
						: <div className="dsh-dictate-hint">Audio goes to OpenRouter for transcription; nothing is stored.</div>}
				</div>
			)}
		</div>
	);
}
