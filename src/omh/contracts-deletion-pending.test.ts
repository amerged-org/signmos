import { PDFDocument } from "pdf-lib";
import {
	admin,
	deferDeletionUntil,
	postgres,
	request,
	storedFileCount,
} from "./contracts-crud-otp-test-fixture";

it("preserves pending deletion deadlines and replay headers until a new-key retry proves erasure", async () => {
	const pdf = await PDFDocument.create();
	pdf.addPage([612, 792]);
	const payload = {
		title: "Deletion drain window",
		recipient: { name: "Ada", email: "ada@example.com" },
		pdf: { filename: "agreement.pdf", base64: Buffer.from(await pdf.save()).toString("base64") },
	};
	const created = await request(
		"/api/contracts/drafts",
		admin("POST", "create-pending-delete", payload),
	);
	expect(created.status).toBe(201);
	const id = ((await created.json()) as { data: { id: string } }).data.id;
	const retryAt = new Date(Math.ceil((Date.now() + 330000) / 1000) * 1000).toISOString();
	deferDeletionUntil(retryAt);
	const first = await request(`/api/contracts/${id}`, admin("DELETE", "pending-delete"));
	expect(first.status).toBe(503);
	const body = await first.json();
	expect(body).toMatchObject({
		error: { code: "STORAGE_DELETE_PENDING", retryAt, retryable: true },
	});
	expect(first.headers.get("retry-after")).toBe(new Date(retryAt).toUTCString());
	expect((await postgres.query("SELECT status FROM envelopes WHERE id=$1", [id])).rows).toEqual([
		{ status: "draft" },
	]);
	expect(storedFileCount()).toBe(1);
	const replay = await request(`/api/contracts/${id}`, admin("DELETE", "pending-delete"));
	expect(replay.status).toBe(503);
	await expect(replay.json()).resolves.toEqual(body);
	expect(replay.headers.get("retry-after")).toBe(first.headers.get("retry-after"));
	deferDeletionUntil();
	expect((await request(`/api/contracts/${id}`, admin("DELETE", "completed-delete"))).status).toBe(
		200,
	);
	expect(storedFileCount()).toBe(0);
});
