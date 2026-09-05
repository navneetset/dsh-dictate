/**
 * Dictation controller: mic capture + voice-activity segmentation + the
 * transcribe queue. Framework-free so the React button stays a thin shell.
 *
 * Hands-free mode segments on silence (RMS threshold with a tail) and
 * force-splits long continuous speech before OpenRouter's 60s ceiling;
 * push-to-talk records one segment between pointerdown and pointerup.
 */
import { prefs } from "./prefs";

export type DictationPhase = "idle" | "recording" | "transcribing" | "error";
export type DictationState = { phase: DictationPhase; mode?: "ptt" | "handsfree"; error?: string };

const MIN_SPEECH_MS = 300; // discard blips
const SILENCE_TAIL_MS = 700; // pause that closes a segment
const FORCE_SPLIT_MS = 25_000; // hard split well before the 60s ceiling
const RMS_INTERVAL_MS = 50;
const B64_SLICE = 0x8000;

function pickMime(): { mime: string; format: string } {
	const candidates = [
		["audio/webm;codecs=opus", "webm"],
		["audio/webm", "webm"],
		["audio/ogg;codecs=opus", "ogg"],
		["audio/mp4", "m4a"],
	];
	if (typeof MediaRecorder !== "undefined") {
		for (const [mime, format] of candidates) {
			try {
				if (MediaRecorder.isTypeSupported(mime)) return { mime, format };
			} catch {
				/* keep looking */
			}
		}
	}
	return { mime: "", format: "webm" };
}

async function blobToBase64(blob: Blob): Promise<string> {
	const bytes = new Uint8Array(await blob.arrayBuffer());
	let binary = "";
	for (let i = 0; i < bytes.length; i += B64_SLICE) {
		binary += String.fromCharCode(...bytes.subarray(i, i + B64_SLICE));
	}
	return btoa(binary);
}

class DictationController extends EventTarget {
	state: DictationState = { phase: "idle" };
	/** Set by the button: appends a transcript to the composer draft. */
	inserter?: (text: string) => void;

	private stream?: MediaStream;
	private recorder?: MediaRecorder;
	private audioCtx?: AudioContext;
	private analyser?: AnalyserNode;
	private rmsTimer?: number;
	private chunks: Blob[] = [];
	private mime = "";
	private format = "webm";
	private mode: "ptt" | "handsfree" = "handsfree";
	private speaking = false;
	private speechStartedAt = 0;
	private segmentStartedAt = 0;
	private lastVoiceAt = 0;
	private pending = 0;
	private queue: Promise<void> = Promise.resolve();

	private setState(patch: Partial<DictationState>) {
		this.state = { ...this.state, ...patch };
		this.dispatchEvent(new Event("change"));
	}

	onChange(fn: () => void): () => void {
		this.addEventListener("change", fn);
		return () => this.removeEventListener("change", fn);
	}

	get active(): boolean {
		return this.state.phase === "recording" || this.state.phase === "transcribing";
	}

	toggle() {
		if (this.state.phase === "recording") {
			void this.stop();
			return;
		}
		if (this.state.phase === "idle" || this.state.phase === "error") void this.start(prefs.mode);
	}

	async start(mode: "ptt" | "handsfree") {
		if (this.state.phase === "recording") return;
		if (this.state.phase === "transcribing") return; // let the queue drain
		this.mode = mode;
		try {
			this.stream = await navigator.mediaDevices.getUserMedia({
				audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
			});
		} catch (error) {
			this.setState({
				phase: "error",
				error: error?.name === "NotAllowedError"
					? "Microphone permission denied — allow mic access for this page and retry."
					: `Microphone unavailable: ${error?.message ?? error}`,
			});
			return;
		}
		const picked = pickMime();
		this.mime = picked.mime;
		this.format = picked.format;
		this.chunks = [];
		this.recorder = new MediaRecorder(this.stream, this.mime ? { mimeType: this.mime } : undefined);
		this.recorder.ondataavailable = (event) => {
			if (event.data && event.data.size > 0) this.chunks.push(event.data);
		};
		this.audioCtx = new AudioContext();
		const source = this.audioCtx.createMediaStreamSource(this.stream);
		this.analyser = this.audioCtx.createAnalyser();
		this.analyser.fftSize = 512;
		source.connect(this.analyser);
		this.speaking = false;
		this.speechStartedAt = 0;
		this.lastVoiceAt = 0;
		this.segmentStartedAt = Date.now();
		this.rmsTimer = window.setInterval(() => this.tickRms(), RMS_INTERVAL_MS);
		this.recorder.start(250);
		this.setState({ phase: "recording", mode, error: undefined });
	}

	async stop() {
		if (this.state.phase !== "recording" || !this.recorder) return;
		const recorder = this.recorder;
		const stopped = new Promise<void>((resolve) => {
			recorder.onstop = () => resolve();
		});
		try {
			recorder.stop(); // fires a final dataavailable before onstop
		} catch {
			/* already inactive */
		}
		await stopped;
		const blob = this.takeChunks();
		this.cleanup();
		if (blob && blob.size > 0) this.enqueue(blob);
		this.setState({ phase: this.pending > 0 ? "transcribing" : "idle" });
	}

	private tickRms() {
		if (!this.analyser || this.state.phase !== "recording") return;
		const buffer = new Float32Array(this.analyser.fftSize);
		this.analyser.getFloatTimeDomainData(buffer);
		let sum = 0;
		for (let i = 0; i < buffer.length; i++) sum += buffer[i] * buffer[i];
		const rms = Math.sqrt(sum / buffer.length);
		const now = Date.now();
		if (rms >= prefs.threshold) {
			this.speaking = true;
			this.lastVoiceAt = now;
			if (!this.speechStartedAt) this.speechStartedAt = now;
		}
		if (this.mode !== "handsfree") return;
		const elapsed = now - this.segmentStartedAt;
		if (elapsed >= FORCE_SPLIT_MS) {
			this.cutSegment();
			return;
		}
		if (this.speaking && this.lastVoiceAt && now - this.lastVoiceAt >= SILENCE_TAIL_MS) {
			if (now - (this.speechStartedAt ?? now) >= MIN_SPEECH_MS) this.cutSegment();
			else this.speaking = false;
		}
	}

	/** Close the current segment and keep recording into the next one. */
	private cutSegment() {
		const blob = this.takeChunks();
		this.segmentStartedAt = Date.now();
		this.speechStartedAt = 0;
		this.speaking = false;
		this.lastVoiceAt = 0;
		if (blob && blob.size > 0) this.enqueue(blob);
	}

	private takeChunks(): Blob | null {
		if (this.chunks.length === 0) return null;
		const blob = new Blob(this.chunks, { type: this.mime || "audio/webm" });
		this.chunks = [];
		return blob;
	}

	private enqueue(blob: Blob) {
		this.pending++;
		this.queue = this.queue.then(async () => {
			try {
				await this.submit(blob);
			} finally {
				this.pending--;
				if (this.pending === 0 && this.state.phase === "transcribing") this.setState({ phase: "idle" });
			}
		});
	}

	private async submit(blob: Blob) {
		try {
			const audio = await blobToBase64(blob);
			const response = await fetch("/dictate/transcribe", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					audio,
					format: this.format,
					model: prefs.model,
					language: prefs.language || undefined,
				}),
			});
			const data = await response.json().catch(() => ({}));
			if (!response.ok) {
				const detail = data?.error ?? data?.message;
				throw new Error(typeof detail === "string" ? detail : `Transcription failed (HTTP ${response.status}).`);
			}
			const text = String(data?.text ?? "").trim();
			if (text) this.inserter?.(text);
			if (data?.cost != null) console.info(`[dsh-dictate] segment cost: $${data.cost}`);
		} catch (error) {
			const wasRecording = this.state.phase === "recording";
			if (wasRecording) this.cleanup();
			this.setState({ phase: "error", error: error?.message ?? String(error) });
		}
	}

	private cleanup() {
		if (this.rmsTimer !== undefined) {
			clearInterval(this.rmsTimer);
			this.rmsTimer = undefined;
		}
		try {
			if (this.recorder && this.recorder.state !== "inactive") this.recorder.stop();
		} catch {
			/* already inactive */
		}
		this.recorder = undefined;
		this.stream?.getTracks().forEach((track) => track.stop());
		this.stream = undefined;
		if (this.audioCtx) void this.audioCtx.close().catch(() => {});
		this.audioCtx = undefined;
		this.analyser = undefined;
		this.speaking = false;
		this.speechStartedAt = 0;
		this.lastVoiceAt = 0;
	}
}

export const controller = new DictationController();
