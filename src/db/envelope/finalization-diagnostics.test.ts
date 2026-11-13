import { finalizationPhase } from "./finalization-diagnostics";

describe("finalization diagnostics", () => {
	it("exposes an allowlisted nested provider code without disclosing error details", async () => {
		const secret = "https://private.test/signed?token=secret";
		const failure = Object.assign(new Error(secret), {
			cause: Object.assign(new Error(secret), { code: "gateway_unavailable" }),
		});
		const error = await finalizationPhase("source_read", async () => {
			throw failure;
		}).catch((caught: unknown) => caught);
		expect(error).toMatchObject({ phase: "source_read", reason: "gateway_unavailable" });
		expect(JSON.stringify(error)).not.toContain(secret);
	});

	it("never reflects an arbitrary error code", async () => {
		await expect(
			finalizationPhase("pdf_render", async () => {
				throw Object.assign(new Error("sensitive"), { code: "sensitive" });
			}),
		).rejects.toMatchObject({ phase: "pdf_render", reason: "internal_error" });
	});
});
