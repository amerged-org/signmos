// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import { useNoncePositionStyle } from "./nonce-position-style";

function PositionedField({
	x = 72,
	y = 144,
	width = 180,
	height = 48,
}: {
	x?: number;
	y?: number;
	width?: number;
	height?: number;
}) {
	const position = useNoncePositionStyle({ x, y, width, height }, { width: 612, height: 792 });
	return (
		<>
			{position.styles}
			<div data-testid="field" className={position.className} />
		</>
	);
}

afterEach(() => {
	cleanup();
	document.querySelector('meta[name="csp-nonce"]')?.remove();
	vi.unstubAllGlobals();
});

describe("CSP-compatible PDF overlay positioning", () => {
	it("uses the document nonce and updates one scoped rule when a field moves", () => {
		const nonce = document.createElement("meta");
		nonce.name = "csp-nonce";
		nonce.content = "host-request-nonce";
		document.head.appendChild(nonce);
		const { container, getByTestId, rerender } = render(<PositionedField />);
		const field = getByTestId("field");
		const className = field.className;
		const styles = container.querySelector("style");

		expect(field.getAttribute("style")).toBeNull();
		expect(styles?.nonce).toBe("host-request-nonce");
		expect(styles?.textContent).toBe(
			`.${className}{left:11.764706%;top:18.181818%;width:29.411765%;height:6.060606%;}`,
		);

		rerender(<PositionedField x={306} y={396} />);
		expect(field.className).toBe(className);
		expect(container.querySelectorAll("style")).toHaveLength(1);
		expect(styles?.textContent).toContain("left:50%;top:50%;");
	});

	it("bounds invalid and oversized rectangles without accepting CSS input", () => {
		const { container } = render(
			<PositionedField
				x={"0;}body{display:none}</style><script>alert(1)</script>" as unknown as number}
				y={Number.POSITIVE_INFINITY}
				width={10000}
				height={Number.NaN}
			/>,
		);
		expect(container.querySelector("style")?.textContent).toMatch(
			/^\.pdf-field-[a-zA-Z0-9_-]+\{left:0%;top:0%;width:100%;height:0%;\}$/,
		);
		expect(container.querySelector("script")).toBeNull();
		expect(container.querySelectorAll("[style]")).toHaveLength(0);
	});

	it("keeps each field within the page and isolates neighboring field rules", () => {
		const { container } = render(
			<>
				<PositionedField x={612} y={792} width={306} height={396} />
				<PositionedField x={-5} y={-10} />
			</>,
		);
		const fields = container.querySelectorAll("[data-testid=field]");
		const rules = container.querySelectorAll("style");
		expect(fields[0]?.className).not.toBe(fields[1]?.className);
		expect(rules[0]?.textContent).toContain("left:50%;top:50%;width:50%;height:50%;");
		expect(rules[1]?.textContent).toContain("left:0%;top:0%;");
	});

	it("renders safely before the host adds the SSR nonce", () => {
		vi.stubGlobal("document", undefined);
		const markup = renderToStaticMarkup(<PositionedField />);
		expect(markup).toContain("<style>");
		expect(markup).not.toContain("style=");
		vi.unstubAllGlobals();
	});
});
