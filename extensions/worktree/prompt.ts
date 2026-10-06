/**
 * Minimal arrow-key selector for the raw terminal. Used on quit, after pi's
 * TUI has already been torn down (so ctx.ui dialogs are unavailable).
 */

import * as readline from "node:readline";

const ESC = "\x1b[";
const c = {
	reset: `${ESC}0m`,
	bold: (s: string) => `${ESC}1m${s}${ESC}22m`,
	dim: (s: string) => `${ESC}2m${s}${ESC}22m`,
	green: (s: string) => `${ESC}32m${s}${ESC}39m`,
	yellow: (s: string) => `${ESC}33m${s}${ESC}39m`,
	red: (s: string) => `${ESC}31m${s}${ESC}39m`,
	cyan: (s: string) => `${ESC}36m${s}${ESC}39m`,
};
export const color = c;

export interface Choice<T> {
	label: string;
	hint?: string;
	value: T;
}

/**
 * Render `header` lines, then a ↑/↓ list of choices. Enter confirms; Esc,
 * Ctrl+C and Ctrl+D pick `fallback`. Resolves to the chosen value.
 */
export function select<T>(header: string[], choices: Choice<T>[], initial: number, fallback: T): Promise<T> {
	const out = process.stderr;
	const input = process.stdin;
	let index = initial;

	const draw = (first: boolean) => {
		if (!first) out.write(`${ESC}${choices.length}A`);
		for (const [i, ch] of choices.entries()) {
			const on = i === index;
			const pointer = on ? c.cyan("❯") : " ";
			const label = on ? c.bold(c.cyan(ch.label)) : ch.label;
			const hint = ch.hint ? `  ${c.dim(ch.hint)}` : "";
			out.write(`${ESC}2K  ${pointer} ${label}${hint}\n`);
		}
	};

	return new Promise((resolve) => {
		out.write(`${header.join("\n")}\n`);
		out.write(`${ESC}?25l`); // hide cursor
		draw(true);

		readline.emitKeypressEvents(input);
		const wasRaw = input.isRaw;
		input.setRawMode(true);
		input.resume();

		const finish = (value: T) => {
			input.off("keypress", onKey);
			input.setRawMode(wasRaw);
			input.pause();
			out.write(`${ESC}?25h`);
			resolve(value);
		};

		const onKey = (_str: string | undefined, key: readline.Key | undefined) => {
			if (!key) return;
			if (key.ctrl && (key.name === "c" || key.name === "d")) return finish(fallback);
			switch (key.name) {
				case "up":
				case "k":
					index = (index - 1 + choices.length) % choices.length;
					return draw(false);
				case "down":
				case "j":
				case "tab":
					index = (index + 1) % choices.length;
					return draw(false);
				case "return":
				case "enter":
					return finish(choices[index]!.value);
				case "escape":
					return finish(fallback);
				case "y":
					return finish(choices.find((ch) => /^yes/i.test(ch.label))?.value ?? fallback);
				case "n":
					return finish(choices.find((ch) => /^no/i.test(ch.label))?.value ?? fallback);
			}
		};
		input.on("keypress", onKey);
	});
}
