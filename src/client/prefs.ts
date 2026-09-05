/** Per-user dictation preferences, kept in localStorage and sent per request. */

export type DictatePrefs = {
	model: string;
	language: string;
	mode: "handsfree" | "ptt";
	hotkey: boolean;
	threshold: number;
};

const KEY = "dsh-dictate.prefs.v1";

const DEFAULTS: DictatePrefs = {
	model: "openai/gpt-4o-mini-transcribe",
	language: "",
	mode: "handsfree",
	hotkey: true,
	threshold: 0.015,
};

const listeners = new Set<() => void>();

function read(): DictatePrefs {
	try {
		return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(KEY) ?? "{}") };
	} catch {
		return { ...DEFAULTS };
	}
}

export let prefs: DictatePrefs = read();

export function updatePrefs(patch: Partial<DictatePrefs>) {
	prefs = { ...prefs, ...patch };
	try {
		localStorage.setItem(KEY, JSON.stringify(prefs));
	} catch {
		/* private mode; prefs stay for the session */
	}
	listeners.forEach((fn) => fn());
}

export function onPrefsChange(fn: () => void): () => void {
	listeners.add(fn);
	return () => listeners.delete(fn);
}
