import { type ReactElement, useId } from "react";

interface Rectangle {
	x: number;
	y: number;
	width: number;
	height: number;
}

interface PageDimensions {
	width: number;
	height: number;
}

/** Position PDF overlays without inline attributes, which the host CSP blocks. */
export function useNoncePositionStyle(
	rectangle: Rectangle,
	page: PageDimensions,
): { className: string; styles: ReactElement } {
	const id = useId();
	const className = `pdf-field-${id.replace(/[^a-zA-Z0-9_-]/g, "")}`;
	const pageWidth = positiveDimension(page.width);
	const pageHeight = positiveDimension(page.height);
	const width = boundedNumber(rectangle.width, pageWidth);
	const height = boundedNumber(rectangle.height, pageHeight);
	const left = boundedNumber(rectangle.x, pageWidth - width);
	const top = boundedNumber(rectangle.y, pageHeight - height);
	// Only finite, bounded numbers and the generated identifier can enter CSS.
	const rule = `.${className}{left:${percentage(left, pageWidth)}%;top:${percentage(top, pageHeight)}%;width:${percentage(width, pageWidth)}%;height:${percentage(height, pageHeight)}%;}`;
	return {
		className,
		styles: (
			<style nonce={documentNonce()} suppressHydrationWarning>
				{rule}
			</style>
		),
	};
}

function documentNonce(): string | undefined {
	if (typeof document === "undefined") return undefined;
	return document.querySelector<HTMLMetaElement>('meta[name="csp-nonce"]')?.content || undefined;
}

function positiveDimension(value: number): number {
	return Number.isFinite(value) && value > 0 ? value : 1;
}

function boundedNumber(value: number, maximum: number): number {
	return Number.isFinite(value) ? Math.max(0, Math.min(maximum, value)) : 0;
}

function percentage(value: number, dimension: number): string {
	return String(Number(((value / dimension) * 100).toFixed(6)));
}
