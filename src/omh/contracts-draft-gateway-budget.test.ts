import { PDFDocument } from "pdf-lib";
import {
	admin,
	afterNextUploadComplete,
	browserAdmin,
	failNextSourceSave,
	loseNextReservationReceipt,
	owner,
	postgres,
	request,
	requestBudgets,
	storedFileCount,
} from "./contracts-crud-otp-test-fixture";

it.each([
	"bearer",
	"browser",
] as const)("keeps %s late replacement races and uncertain storage receipts within ten real private calls", async (identity) => {
	const authorize = identity === "bearer" ? admin : browserAdmin;
	const pdf = await PDFDocument.create();
	pdf.addPage([612, 792]);
	const payload = {
		title: "Gateway budget",
		recipient: { name: "Ada", email: "ada@example.com" },
		pdf: { filename: "agreement.pdf", base64: Buffer.from(await pdf.save()).toString("base64") },
	};
	const created = await request("/api/contracts/drafts", authorize("POST", "create", payload));
	expect(created.status).toBe(201);
	const id = ((await created.json()) as { data: { id: string } }).data.id;
	for (const change of ["owner", "status", "receipt"] as const) {
		afterNextUploadComplete(async () => {
			if (change === "owner")
				await postgres.query("UPDATE envelopes SET created_by='other@example.com' WHERE id=$1", [
					id,
				]);
			if (change === "status")
				await postgres.query("UPDATE envelopes SET status='expired' WHERE id=$1", [id]);
			if (change === "receipt") throw new Error("Upload completed but receipt was lost");
		});
		const response = await request(
			`/api/contracts/${id}/pdf`,
			authorize("PUT", `replace-${change}`, payload),
		);
		expect(response.status).toBe(change === "receipt" ? 503 : 409);
		expect(requestBudgets().at(-1)).toMatchObject({
			files: change === "receipt" ? 4 : 3,
			total: 10,
		});
		await postgres.query("UPDATE envelopes SET status='draft',created_by=$1 WHERE id=$2", [
			owner,
			id,
		]);
	}
	expect(storedFileCount()).toBe(3);
	const deleted = await request(`/api/contracts/${id}`, authorize("DELETE", "delete"));
	expect(deleted.status).toBe(200);
	expect(storedFileCount()).toBe(0);
});

it.each([
	"save-rollback",
	"reservation-receipt",
] as const)("reconciles %s without leaving a draft permanently undeletable", async (failure) => {
	const pdf = await PDFDocument.create();
	pdf.addPage([612, 792]);
	const payload = {
		title: "Recovery",
		recipient: { name: "Ada", email: "ada@example.com" },
		pdf: { filename: "agreement.pdf", base64: Buffer.from(await pdf.save()).toString("base64") },
	};
	if (failure === "save-rollback") failNextSourceSave();
	else loseNextReservationReceipt();
	const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
	try {
		const failed = await request(
			"/api/contracts/drafts",
			admin("POST", "create-recovery", payload),
		);
		expect(failed.status).toBe(503);
		const id = (await postgres.query<{ id: string }>("SELECT id FROM envelopes")).rows[0]?.id;
		if (!id) throw new Error("Missing recoverable draft");
		expect((await request(`/api/contracts/${id}`, admin("DELETE", "delete-recovery"))).status).toBe(
			200,
		);
		expect(storedFileCount()).toBe(0);
	} finally {
		logged.mockRestore();
	}
});
