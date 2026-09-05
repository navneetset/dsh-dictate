/**
 * OpenRouter STT proxy: one transcription request, with errors mapped to
 * readable messages the browser can show verbatim.
 */

const FORMATS = new Set(["wav", "mp3", "flac", "m4a", "ogg", "webm", "aac"]);
const TIMEOUT_MS = 65_000; // OpenRouter's upstream STT timeout is 60s.

export class TranscribeError extends Error {
	status: number;
	constructor(status: number, message: string) {
		super(message);
		this.status = status;
	}
}

export function isAllowedFormat(format) {
	return typeof format === "string" && FORMATS.has(format);
}

export function isAllowedLanguage(language) {
	return typeof language === "string" && /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})?$/.test(language);
}

/**
 * POST one segment to OpenRouter's OpenAI-compatible transcriptions endpoint.
 * @returns the trimmed transcript and, when OpenRouter reports it, the cost.
 */
export async function transcribe(options) {
	const { endpoint, apiKey, audio, format, model, language } = options;
	const body = {
		model: model || "openai/gpt-4o-mini-transcribe",
		input_audio: { data: audio, format },
		...(language ? { language } : {}),
	};
	let response;
	try {
		response = await fetch(endpoint, {
			method: "POST",
			headers: {
				authorization: `Bearer ${apiKey}`,
				"content-type": "application/json",
			},
			body: JSON.stringify(body),
			signal: AbortSignal.timeout(TIMEOUT_MS),
		});
	} catch (error) {
		throw new TranscribeError(504, `Could not reach OpenRouter: ${error?.cause?.message ?? error?.message ?? error}`);
	}
	const data = await response.json().catch(() => ({}));
	if (!response.ok) {
		const detail = typeof data?.error?.message === "string" ? data.error.message : typeof data?.message === "string" ? data.message : "";
		const map = {
			401: "OpenRouter rejected the API key (401). Check OPENROUTER_API_KEY.",
			402: "OpenRouter account is out of credits (402).",
			404: `Unknown transcription model on OpenRouter (404).${detail ? ` ${detail}` : ""}`,
			413: "Audio segment too large for OpenRouter (413).",
			429: "OpenRouter rate limit hit (429); try again in a moment.",
			524: "OpenRouter upstream timed out (524); the segment may have been too long.",
		};
		throw new TranscribeError(response.status === 524 ? 504 : response.status >= 500 ? 502 : response.status, map[response.status] ?? `Transcription failed (HTTP ${response.status}).${detail ? ` ${detail}` : ""}`);
	}
	return { text: String(data?.text ?? "").trim(), cost: data?.usage?.cost ?? null };
}
