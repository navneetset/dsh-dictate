/**
 * dsh-plugin-dictate — host half.
 *
 * Registers an exact POST route that proxies one audio segment to OpenRouter's
 * STT endpoint (the API key never reaches the browser) plus a `/dictate`
 * human command pointing at the mic button. The client half (same package)
 * renders the mic button into the composer's tool row.
 *
 * @module dsh-plugin-dictate
 */
import z from "@deepseek-ai/schemastery";
import { isAllowedFormat, isAllowedLanguage, transcribe, TranscribeError } from "./transcribe.js";

/** Stable Cordis plugin name. */
const name = "dictate";

/** Services the plugin reads. */
const inject = ["webServer", "commands"];

const Config = z.object({
	apiKeyEnv: z.string().default("OPENROUTER_API_KEY"),
	/** Plain-value fallback for deployments that can't set the env var; prefer apiKeyEnv. */
	apiKey: z.string().default(""),
	endpoint: z.string().default("https://openrouter.ai/api/v1/audio/transcriptions"),
	routePath: z.string().default("/dictate/transcribe"),
	maxAudioBytes: z.natural().default(25_000_000),
});

/** Collect a request body, refusing anything over the byte budget. */
function readBody(req, limit) {
	return new Promise((resolve, reject) => {
		const declared = Number(req.headers["content-length"] ?? 0);
		if (declared > limit) {
			reject(Object.assign(new Error("payload too large"), { code: "too-large" }));
			return;
		}
		const chunks = [];
		let total = 0;
		req.on("data", (chunk) => {
			total += chunk.length;
			if (total > limit) {
				req.destroy();
				reject(Object.assign(new Error("payload too large"), { code: "too-large" }));
				return;
			}
			chunks.push(chunk);
		});
		req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
		req.on("error", reject);
	});
}

function sendJson(res, status, payload) {
	res.writeHead(status, { "content-type": "application/json" });
	res.end(JSON.stringify(payload));
}

/** Handle one POST /dictate/transcribe segment. */
async function handle(ctx, cfg, req, res) {
	if (req.method !== "POST") {
		sendJson(res, 405, { error: "POST audio segments to this route." });
		return;
	}
	const apiKey = cfg.apiKey || process.env[cfg.apiKeyEnv];
	if (!apiKey) {
		sendJson(res, 503, { error: `Missing OpenRouter API key: set the ${cfg.apiKeyEnv} environment variable and restart dsh web (or set the dictate apiKey config).` });
		return;
	}
	let raw;
	try {
		raw = await readBody(req, cfg.maxAudioBytes);
	} catch (error) {
		sendJson(res, error?.code === "too-large" ? 413 : 400, { error: error?.code === "too-large" ? "Audio segment exceeds the configured size limit." : "Could not read the request body." });
		return;
	}
	let payload;
	try {
		payload = JSON.parse(raw);
	} catch {
		sendJson(res, 400, { error: "Request body must be JSON." });
		return;
	}
	const audio = typeof payload?.audio === "string" ? payload.audio : "";
	const format = payload?.format ?? "webm";
	const model = typeof payload?.model === "string" ? payload.model.slice(0, 160) : undefined;
	const language = typeof payload?.language === "string" ? payload.language : undefined;
	if (!audio) {
		sendJson(res, 400, { error: "Missing audio payload." });
		return;
	}
	if (!isAllowedFormat(format)) {
		sendJson(res, 400, { error: `Unsupported audio format "${String(format).slice(0, 20)}".` });
		return;
	}
	if (language !== undefined && !isAllowedLanguage(language)) {
		sendJson(res, 400, { error: `Unsupported language code "${String(language).slice(0, 12)}".` });
		return;
	}
	if (Buffer.byteLength(audio, "base64") > cfg.maxAudioBytes) {
		sendJson(res, 413, { error: "Audio segment exceeds the configured size limit." });
		return;
	}
	try {
		const result = await transcribe({ endpoint: cfg.endpoint, apiKey, audio, format, model, language: language || undefined });
		sendJson(res, 200, result);
	} catch (error) {
		if (error instanceof TranscribeError) {
			sendJson(res, error.status, { error: error.message });
			return;
		}
		ctx.logger?.warn?.(error instanceof Error ? error : new Error(String(error)));
		sendJson(res, 502, { error: "Transcription failed unexpectedly; see the dsh log." });
	}
}

/**
 * Register the transcribe route and the /dictate command.
 * @param ctx - plugin context carrying webServer and commands.
 * @param config - validated Config (schemastery applies the defaults).
 */
function apply(ctx, config) {
	const cfg = {
		apiKeyEnv: config?.apiKeyEnv ?? "OPENROUTER_API_KEY",
		apiKey: config?.apiKey ?? "",
		endpoint: config?.endpoint ?? "https://openrouter.ai/api/v1/audio/transcriptions",
		routePath: config?.routePath ?? "/dictate/transcribe",
		maxAudioBytes: config?.maxAudioBytes ?? 25_000_000,
	};
	ctx.effect(() => ctx.webServer.register({
		kind: "exact",
		path: cfg.routePath,
		handler: (req, res) => handle(ctx, cfg, req, res),
	}), "dictate: transcribe route");
	ctx.effect(() => ctx.commands.register({
		name: "dictate",
		description: "Voice dictation — use the microphone button in the composer",
		handler: async () => ({
			kind: "success",
			text: "dsh-dictate is running. Click the microphone button at the left of the composer tool row to dictate hands-free (Ctrl+M toggles), or hold it in push-to-talk mode. Right-click the button for model, language, and mode settings. Audio is transcribed through OpenRouter and never stored.",
		}),
	}), "dictate: command");
}

export { Config, apply, inject, name };
