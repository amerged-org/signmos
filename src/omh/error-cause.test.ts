import { findCause } from "./error-cause";

class Marker extends Error {}
const isMarker = (candidate: unknown): candidate is Marker => candidate instanceof Marker;

/** `depth` plain errors, each the cause of the one before it, ending in `innermost`. */
function wrapped(innermost: unknown, depth: number): Error {
	let error: unknown = innermost;
	for (let level = 0; level < depth; level += 1)
		error = new Error(`wrapper ${level}`, { cause: error });
	return error as Error;
}

describe("finding an error behind its wrappers", () => {
	it("returns the error itself when it matches, and the outermost match otherwise", () => {
		const outer = new Marker("outer");
		const inner = new Marker("inner");
		expect(findCause(inner, isMarker)).toBe(inner);
		expect(findCause(new Error("wrapper", { cause: outer }), isMarker)).toBe(outer);
		expect(findCause(wrapped(new Marker("outer", { cause: inner }), 3), isMarker)?.message).toBe(
			"outer",
		);
	});

	it("looks through plain causes a few levels deep", () => {
		const marker = new Marker("found");
		expect(findCause(wrapped(marker, 5), isMarker)).toBe(marker);
	});

	it("finds nothing in errors without a matching cause, or in values that are not errors", () => {
		expect(findCause(new TypeError("bug"), isMarker)).toBeUndefined();
		expect(findCause(wrapped(new TypeError("bug"), 2), isMarker)).toBeUndefined();
		expect(findCause("text", isMarker)).toBeUndefined();
		expect(findCause(undefined, isMarker)).toBeUndefined();
		// Only errors are followed: a plain object's `cause` is data, not a wrapped error.
		expect(findCause({ cause: new Marker("hidden") }, isMarker)).toBeUndefined();
	});

	it("stops at a cause that points back at the error instead of looping", () => {
		const loop = new Error("loop");
		loop.cause = loop;
		expect(findCause(loop, isMarker)).toBeUndefined();
		const first = new Error("first");
		const second = new Error("second", { cause: first });
		first.cause = second;
		expect(findCause(first, isMarker)).toBeUndefined();
	});

	it("gives up on a chain far deeper than any real wrapper nesting", () => {
		expect(findCause(wrapped(new Marker("buried"), 50), isMarker)).toBeUndefined();
	});
});
