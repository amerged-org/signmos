import fontkit from "@pdf-lib/fontkit";
import fontDataUrl from "./fonts/NotoSans-Regular.ttf?inline";

let cachedBytes: Uint8Array | undefined;
let cachedCharacters: Set<number> | undefined;

export function placeholderFontBytes(): Uint8Array {
	if (!cachedBytes) {
		const base64 = fontDataUrl.slice(fontDataUrl.indexOf(",") + 1);
		const binary = atob(base64);
		cachedBytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
	}
	return cachedBytes;
}

/** Reject unsupported characters before a signer completes, rather than silently drawing tofu. */
export function supportsPlaceholderText(value: string): boolean {
	if (!cachedCharacters)
		cachedCharacters = new Set(fontkit.create(placeholderFontBytes()).characterSet);
	return [...value.replace(/[\r\n]+/g, " ")].every((character) => {
		const code = character.codePointAt(0);
		return code !== undefined && cachedCharacters?.has(code);
	});
}
