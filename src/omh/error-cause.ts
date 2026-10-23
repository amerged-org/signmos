/** How many wrappers deep the search goes; real nesting is two or three levels (query error, step marker). */
const MAX_CAUSE_DEPTH = 8;

/**
 * The outermost error in a chain of `cause`s that `matches`, or undefined. A platform client's
 * error reaches the response handlers inside wrappers: drizzle's query error, whose text carries
 * the SQL and its parameters, and the marker of the creation step. Those must neither hide the
 * error's code nor be shown. Only errors are followed, and the search stops after
 * MAX_CAUSE_DEPTH levels so that a cause pointing back at its error cannot loop.
 */
export function findCause<Match>(
	error: unknown,
	matches: (candidate: unknown) => candidate is Match,
): Match | undefined {
	let candidate: unknown = error;
	for (let depth = 0; depth < MAX_CAUSE_DEPTH; depth += 1) {
		if (matches(candidate)) return candidate;
		if (!(candidate instanceof Error)) return undefined;
		candidate = candidate.cause;
	}
	return undefined;
}
