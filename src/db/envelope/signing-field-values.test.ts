import { type CompleteSigningRequest, EnvelopeFieldSchema } from "./schema";
import { resolveSigningFieldValues } from "./signing-field-values";

const base = {
	envelopeId: "00000000-0000-4000-8000-000000000001",
	recipientId: "00000000-0000-4000-8000-000000000002",
	page: 1,
	x: 10,
	y: 10,
	width: 100,
	height: 20,
	createdAt: new Date(),
};
const field = (
	id: string,
	name: string,
	type: "text" | "signature" | "checkbox" | "date",
	required = true,
) => EnvelopeFieldSchema.parse({ ...base, id, name, type, required, isPlaceholder: true });
const id1 = "00000000-0000-4000-8000-000000000011";
const id2 = "00000000-0000-4000-8000-000000000012";
const id3 = "00000000-0000-4000-8000-000000000013";
const request = (fieldValues: CompleteSigningRequest["fieldValues"]): CompleteSigningRequest => ({
	fieldValues,
	rememberSignature: false,
});

describe("signer field values", () => {
	it("expands a repeated marker and preserves empty optional fields", () => {
		const values = resolveSigningFieldValues(
			[field(id1, "name", "text"), field(id2, "name", "text"), field(id3, "note", "text", false)],
			request({ [id1]: " Ada " }),
			undefined,
			"2026-11-13",
		);
		expect([...values.values()]).toEqual(["Ada", "Ada", ""]);
	});
	it("rejects missing required fields, unchecked boxes and other recipients' field IDs", () => {
		const fields = [field(id1, "agree", "checkbox")];
		expect(() =>
			resolveSigningFieldValues(fields, request({ [id1]: false }), undefined, "2026-11-13"),
		).toThrow("required");
		expect(() =>
			resolveSigningFieldValues(fields, request({ [id2]: true }), undefined, "2026-11-13"),
		).toThrow("does not belong");
	});
	it("rejects conflicting repeated values and invalid dates", () => {
		expect(() =>
			resolveSigningFieldValues(
				[field(id1, "name", "text"), field(id2, "name", "text")],
				request({ [id1]: "A", [id2]: "B" }),
				undefined,
				"2026-11-13",
			),
		).toThrow("Conflicting");
		expect(() =>
			resolveSigningFieldValues(
				[field(id1, "date", "date")],
				request({ [id1]: "2026-02-30" }),
				undefined,
				"2026-11-13",
			),
		).toThrow("valid date");
	});
	it("allows an omitted optional signature and rejects a missing required signature", () => {
		expect(
			resolveSigningFieldValues(
				[field(id1, "sign", "signature", false)],
				request({}),
				undefined,
				"2026-11-13",
			).get(id1),
		).toBe("");
		expect(() =>
			resolveSigningFieldValues(
				[field(id1, "sign", "signature")],
				request({}),
				undefined,
				"2026-11-13",
			),
		).toThrow("required");
		expect(
			resolveSigningFieldValues(
				[field(id1, "sign", "signature", false), field(id2, "sign", "signature", false)],
				request({ [id1]: true }),
				"Ada",
				"2026-11-13",
			).get(id2),
		).toBe("Ada");
		expect(() =>
			resolveSigningFieldValues(
				[field(id1, "sign", "signature", false)],
				request({ [id1]: true }),
				undefined,
				"2026-11-13",
			),
		).toThrow("required");
	});
});
