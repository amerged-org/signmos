export type FinalizationPhase =
	| "source_read"
	| "pdf_render"
	| "artifact_register"
	| "final_upload"
	| "artifact_commit";

const safeCodes = new Set([
	"gateway_configuration_invalid",
	"gateway_not_enabled",
	"gateway_rate_limited",
	"gateway_response_invalid",
	"gateway_route_denied",
	"gateway_timeout",
	"gateway_unavailable",
	"storage_binding_data_changed",
	"storage_conflict",
	"storage_object_not_found",
	"storage_quota_exceeded",
	"storage_upload_expired",
	"storage_upload_pending",
	"storage_upload_rejected",
	"INVALID_SOURCE_PDF",
	"FIELD_PAGE_MISSING",
]);

/** Exposes only an intentional phase and an allowlisted error code, never provider payloads. */
export class FinalizationPhaseError extends Error {
	readonly reason: string;

	constructor(
		readonly phase: FinalizationPhase,
		cause: unknown,
	) {
		super("Final document processing failed");
		this.name = "FinalizationPhaseError";
		this.reason = safeErrorCode(cause);
	}
}

function safeErrorCode(error: unknown): string {
	const visited = new Set<unknown>();
	let current = error;
	while (typeof current === "object" && current !== null && !visited.has(current)) {
		visited.add(current);
		if ("code" in current && typeof current.code === "string" && safeCodes.has(current.code))
			return current.code;
		current = "cause" in current ? current.cause : undefined;
	}
	return "internal_error";
}

export async function finalizationPhase<Result>(
	phase: FinalizationPhase,
	operation: () => Promise<Result>,
): Promise<Result> {
	try {
		return await operation();
	} catch (error) {
		throw new FinalizationPhaseError(phase, error);
	}
}
