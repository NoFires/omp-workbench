import { decodeInput } from "@oh-my-pi/pi-tui/driver/input/decoder";

/**
 * The theme functions row views use. `ctx.ui.theme` and the theme a
 * `ctx.ui.custom` factory receives both satisfy it.
 */
export interface ViewTheme {
	fg(color: string, text: string): string;
	bg(color: string, text: string): string;
	bold(text: string): string;
}

/** One key (`id` is omp's key id such as "enter"; `text` is what it types) or one paste (`id` "paste"). */
export interface ViewKey {
	id: string;
	text: string;
}

/**
 * Keys and pastes in one raw input chunk, in order. omp hands a rows view the
 * raw bytes of each key; this is what replaced pi-tui's `parseKey`, and it
 * reads every encoding (legacy sequences, kitty/CSI-u, bracketed paste) the
 * same way the built-in widgets do.
 */
export function viewKeys(data: string): ViewKey[] {
	const keys: ViewKey[] = [];
	for (const event of decodeInput(data)) {
		if (event.type === "key" && event.key.kind !== "release") {
			keys.push({ id: event.key.id, text: event.key.text ?? "" });
		} else if (event.type === "paste") {
			keys.push({ id: "paste", text: event.paste.text });
		}
	}
	return keys;
}
