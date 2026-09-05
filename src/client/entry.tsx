/**
 * dsh-plugin-dictate — client entry (browser half).
 *
 * Loaded by the dsh client module system as a Cordis plugin; registers the
 * mic button into the composer's left tool-row slot. `inject` declares the
 * guarded services this plugin reads.
 */
import { MicButton } from "./mic-button";

export const inject = ["slots"];

export function apply(ctx) {
	const disposers = [];
	try {
		disposers.push(ctx.slots.inject("conversation.input.left", () =>
			ctx.slots.register(
				{ name: "conversation.input.left", id: "dsh-dictate", order: 100, label: "Dictate" },
				MicButton,
			),
		));
	} catch (error) {
		console.warn("[dsh-dictate] could not register the mic button:", error?.message ?? error);
	}
	return () => {
		for (const dispose of disposers) {
			if (typeof dispose === "function") dispose();
		}
	};
}
