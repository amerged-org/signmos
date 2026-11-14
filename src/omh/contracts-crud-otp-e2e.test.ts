import { PDFDocument, StandardFonts } from "pdf-lib";
import { getDocument } from "pdfjs-dist";
import {
	admin,
	attempts,
	browserAdmin,
	deliveries,
	env,
	loseNextInvitationReceipt,
	otherToken,
	owner,
	postgres,
	recipient,
	request,
	scoped,
	storedFileCount,
} from "./contracts-crud-otp-test-fixture";
import { processContractInvitations } from "./contracts-outbox";
import { processFinalDeliveries } from "./final-delivery-outbox";

interface Contract {
	id: string;
	title: string;
	status: string;
	recipients: Array<{ email: string; status: string }>;
	signingLinks: Array<{ recipientId: string; email: string; url: string }>;
}
interface Definition {
	title: string;
	recipients: Array<{ index: number; name: string; email: string }>;
	fields: Array<{
		recipient: number;
		name: string;
		type: "signature" | "text";
		label: string;
		required: boolean;
	}>;
}

const readContract = async (response: Response): Promise<Contract> =>
	((await response.json()) as { data: Contract }).data;

function definition(includeOwner = true): Definition {
	const recipients = [{ index: 1, name: "Ada", email: recipient }];
	if (includeOwner) recipients.push({ index: 2, name: "Owner", email: owner });
	return {
		title: "Initial agreement",
		recipients,
		fields: recipients.flatMap(({ index }) => [
			{ recipient: index, name: "name", type: "text" as const, label: "Name", required: true },
			{ recipient: index, name: "sign", type: "signature" as const, label: "Sign", required: true },
		]),
	};
}
async function upload(spec: Definition, revision = "Original agreement") {
	const pdf = await PDFDocument.create();
	pdf.setCreationDate(new Date("2026-11-14T00:00:00Z"));
	pdf.setModificationDate(new Date("2026-11-14T00:00:00Z"));
	const page = pdf.addPage([612, 792]);
	const font = await pdf.embedFont(StandardFonts.Helvetica);
	page.drawText(revision, { x: 70, y: 740, size: 12, font });
	for (const [index, field] of spec.fields.entries())
		page.drawText(`{{${field.recipient}.${field.name}}}`, {
			x: 70,
			y: 670 - index * 70,
			size: 12,
			font,
		});
	const form = new FormData();
	form.set(
		"pdf",
		new Blob([Uint8Array.from(await pdf.save()).buffer], { type: "application/pdf" }),
		"agreement.pdf",
	);
	form.set("definition", JSON.stringify(spec));
	return form;
}
function signerToken(link: Contract["signingLinks"][number]) {
	return new URL(link.url, env.APP_BASE_URL).pathname.split("/").at(-1) ?? "";
}
async function verifyEmail(token: string, email: string) {
	const before = deliveries.size;
	const challenge = await request(`/api/signing/${token}/email-code/request`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: "{}",
	});
	expect(challenge.status).toBe(200);
	expect(deliveries.size).toBe(before + 1);
	const mail = [...deliveries.values()].at(-1);
	if (!mail || mail.to !== email) throw new Error("Missing fixture email challenge");
	const code = mail.text.match(/\b\d{6}\b/u)?.[0];
	if (!code) throw new Error("Missing fixture email code");
	const verified = await request(`/api/signing/${token}/email-code/verify`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ code }),
	});
	expect(verified.status).toBe(200);
	const header = verified.headers.get("set-cookie");
	expect(header).toContain("HttpOnly");
	expect(header).toContain("Secure");
	const cookie = header?.split(";")[0];
	if (!cookie) throw new Error("Missing fixture email session");
	return cookie;
}
function complete(
	token: string,
	cookie: string,
	signatureName: string,
	fieldValues: Record<string, string>,
) {
	return request(`/api/signing/${token}/complete`, {
		method: "POST",
		headers: { "content-type": "application/json", cookie },
		body: JSON.stringify({ signatureName, fieldValues }),
	});
}

it("creates, edits, replaces, manually sends and signs the exact PDF through email-bound sessions", async () => {
	const spec = definition();
	const createdResponse = await request(
		"/api/contracts/drafts",
		admin("POST", "draft-create", await upload(spec)),
	);
	expect(createdResponse.status).toBe(201);
	const created = await readContract(createdResponse);
	expect(created).toMatchObject({ title: spec.title, status: "draft" });
	expect(deliveries.size).toBe(0);
	const id = created.id;
	const replay = await request(
		"/api/contracts/drafts",
		admin("POST", "draft-create", await upload(spec)),
	);
	expect(replay.status).toBe(201);
	expect(await readContract(replay)).toEqual(created);
	expect(
		(
			await request(
				"/api/contracts/drafts",
				admin("POST", "draft-create", await upload({ ...spec, title: "Changed reuse" })),
			)
		).status,
	).toBe(409);
	const detail = await request(`/api/contracts/${id}`, admin("GET", "read"));
	expect(detail.status).toBe(200);
	expect(JSON.stringify(await detail.json())).not.toContain("base64");
	const listed = await request("/api/contracts", admin("GET", "list"));
	expect(await listed.json()).toMatchObject({ data: [{ id }] });
	for (const [method, suffix, body] of [
		["GET", "", undefined],
		["PATCH", "", { title: "Stolen" }],
		["PUT", "/pdf", await upload(spec)],
		["POST", "/send", { delivery: "manual" }],
		["POST", "/cancel", {}],
		["DELETE", "", undefined],
	] as const)
		expect(
			(
				await request(
					`/api/contracts/${id}${suffix}`,
					admin(method, `foreign-${method}-${suffix}`, body, otherToken),
				)
			).status,
		).toBe(404);
	expect(
		(
			await request(
				`/api/contracts/${id}`,
				admin("PATCH", "draft-title", { title: "Reviewed agreement" }),
			)
		).status,
	).toBe(200);
	spec.title = "Replacement agreement";
	expect(
		(
			await request(
				`/api/contracts/${id}/pdf`,
				admin("PUT", "draft-pdf", await upload(spec, "Replacement agreement")),
			)
		).status,
	).toBe(200);
	const versions = await postgres.query<{ version: number }>(
		"SELECT version FROM source_documents WHERE envelope_id=$1 ORDER BY version",
		[id],
	);
	expect(versions.rows.map(({ version }) => version)).toEqual([1, 2]);
	const sentResponse = await request(
		`/api/contracts/${id}/send`,
		admin("POST", "draft-send", { delivery: "manual" }),
	);
	expect(sentResponse.status).toBe(200);
	const sent = await readContract(sentResponse);
	expect(sent.status).toBe("sent");
	expect(sent.signingLinks.map(({ email }) => email).sort()).toEqual([recipient, owner].sort());
	expect(deliveries.size).toBe(0);
	expect(
		(await postgres.query("SELECT * FROM contract_invitation_outbox WHERE envelope_id=$1", [id]))
			.rows,
	).toHaveLength(0);
	expect(
		await readContract(
			await request(
				`/api/contracts/${id}/send`,
				admin("POST", "draft-send", { delivery: "manual" }),
			),
		),
	).toEqual(sent);
	for (const [method, suffix, body] of [
		["PATCH", "", { title: "Changed after send" }],
		["PUT", "/pdf", await upload(spec, "Changed PDF")],
		["DELETE", "", undefined],
	] as const)
		expect(
			(await request(`/api/contracts/${id}${suffix}`, admin(method, `immutable-${method}`, body)))
				.status,
		).toBe(409);
	expect(
		(await postgres.query("SELECT * FROM source_documents WHERE envelope_id=$1", [id])).rows,
	).toHaveLength(2);
	expect(
		(await postgres.query("SELECT * FROM field_values WHERE envelope_id=$1", [id])).rows,
	).toHaveLength(0);
	const adaLink = sent.signingLinks.find(({ email }) => email === recipient);
	const ownerLink = sent.signingLinks.find(({ email }) => email === owner);
	if (!adaLink || !ownerLink) throw new Error("Missing personal signing links");
	const adaToken = signerToken(adaLink);
	const senderToken = signerToken(ownerLink);
	// Existing verified-at magic links also require the new email-bound browser session.
	await postgres.query("UPDATE signer_tokens SET verified_at=now() WHERE envelope_id=$1", [id]);
	for (const suffix of ["", "/source-pdf", "/final-pdf"])
		expect((await request(`/api/signing/${adaToken}${suffix}`)).status).toBe(403);
	expect((await complete(adaToken, "", "Ada", {})).status).toBe(403);
	const ownerCookie = await verifyEmail(senderToken, owner);
	expect(
		(await request(`/api/signing/${adaToken}`, { headers: { cookie: ownerCookie } })).status,
	).toBe(403);
	const adaCookie = await verifyEmail(adaToken, recipient);
	expect(
		(await request(`/api/signing/${adaToken}/source-pdf`, { headers: { cookie: adaCookie } }))
			.status,
	).toBe(200);
	const fields = (
		await postgres.query<{ id: string; recipient_id: string; name: string }>(
			"SELECT id,recipient_id,name FROM envelope_fields WHERE envelope_id=$1",
			[id],
		)
	).rows;
	const values = (recipientId: string, name: string) =>
		Object.fromEntries(
			fields
				.filter((field) => field.recipient_id === recipientId && field.name === "name")
				.map((field) => [field.id, name]),
		);
	const first = await complete(
		adaToken,
		adaCookie,
		"Ada Lovelace",
		values(adaLink.recipientId, "Ada Lovelace"),
	);
	expect(await first.json()).toMatchObject({ data: { envelopeStatus: "sent" } });
	expect(
		(await postgres.query("SELECT * FROM final_documents WHERE envelope_id=$1", [id])).rows,
	).toHaveLength(0);
	const last = await complete(
		senderToken,
		ownerCookie,
		"Owner Signature",
		values(ownerLink.recipientId, "Owner Signature"),
	);
	expect(last.status).toBe(200);
	expect(await last.json()).toMatchObject({ data: { envelopeStatus: "completed" } });
	const download = await request(`/api/contracts/${id}/pdf`, admin("GET", "final"));
	expect(download.status).toBe(200);
	const bytes = new Uint8Array(await download.arrayBuffer());
	const final = await PDFDocument.load(bytes, { updateMetadata: false });
	expect(final.getPageCount()).toBeGreaterThan(1);
	expect(final.getProducer()).toBe("amerged-sign-final-pdf-renderer/4");
	const extracted = await getDocument({ data: bytes.slice() }).promise;
	const page = await extracted.getPage(1);
	const text = (await page.getTextContent()).items
		.flatMap((item) => ("str" in item ? [item.str] : []))
		.join(" ");
	expect(text).toContain("Replacement agreement");
	expect(text).not.toContain("Original agreement");
	expect(text).toContain("Owner Signature");
	expect(text).toContain("Ada Lovelace");
	await extracted.destroy();
	expect(
		(
			await request(
				`/api/contracts/${id}/pdf`,
				admin("GET", "foreign-final", undefined, otherToken),
			)
		).status,
	).toBe(404);
	expect((await request(`/api/signing/${adaToken}/final-pdf`)).status).toBe(403);
	expect(
		(await request(`/api/signing/${adaToken}/final-pdf`, { headers: { cookie: adaCookie } }))
			.status,
	).toBe(200);
	const finalId = (
		await postgres.query<{ id: string }>("SELECT id FROM final_documents WHERE envelope_id=$1", [
			id,
		])
	).rows[0]?.id;
	expect((await request(`/api/final-documents/${finalId}/pdf`)).status).toBe(404);
	expect((await request(`/api/final-documents/${adaToken}/pdf`)).status).toBe(403);
	expect(
		(await request(`/api/final-documents/${adaToken}/pdf`, { headers: { cookie: adaCookie } }))
			.status,
	).toBe(200);
	expect(
		(
			await complete(
				adaToken,
				adaCookie,
				"Ada Lovelace",
				values(adaLink.recipientId, "Ada Lovelace"),
			)
		).status,
	).toBe(409);
	expect(
		(await postgres.query("SELECT * FROM final_documents WHERE envelope_id=$1", [id])).rows,
	).toHaveLength(1);
	const intents = (
		await postgres.query<{ to_email: string; access_path: string; status: string }>(
			"SELECT to_email,access_path,status FROM contract_final_delivery_outbox WHERE envelope_id=$1 ORDER BY to_email",
			[id],
		)
	).rows;
	expect(intents).toEqual([
		{ to_email: recipient, access_path: `/completed-documents/${adaToken}`, status: "queued" },
		{ to_email: owner, access_path: `/my-documents/${id}`, status: "queued" },
	]);
	expect(
		(
			await postgres.query(
				"SELECT job.id FROM contract_final_delivery_outbox job JOIN final_documents final ON final.id=job.final_document_id AND final.sha256=job.final_sha256 WHERE job.envelope_id=$1",
				[id],
			)
		).rows,
	).toHaveLength(2);
	await scoped(() => processFinalDeliveries(env));
	await scoped(() => processFinalDeliveries(env));
	const finalMail = [...deliveries].filter(([key]) => key.startsWith("sign.final."));
	expect(finalMail.map(([, mail]) => mail.to).sort()).toEqual([recipient, owner].sort());
	for (const intent of intents) {
		const mail = finalMail.find(([, message]) => message.to === intent.to_email)?.[1];
		expect(mail?.text).toContain(`https://sign.example.com${intent.access_path}`);
	}
	expect(
		(
			await postgres.query(
				"SELECT status FROM contract_final_delivery_outbox WHERE envelope_id=$1",
				[id],
			)
		).rows,
	).toEqual([{ status: "delivered" }, { status: "delivered" }]);
	expect(attempts.filter((key) => key.startsWith("sign.final."))).toHaveLength(2);
}, 30_000);

it("queues API email links, retries an uncertain gateway receipt idempotently, and cancels without adding the creator", async () => {
	const response = await request(
		"/api/contracts/drafts",
		admin("POST", "email-draft", await upload(definition(false))),
	);
	expect(response.status).toBe(201);
	const { id } = await readContract(response);
	const send = () =>
		request(`/api/contracts/${id}/send`, admin("POST", "email-send", { delivery: "email" }));
	const sentResponse = await send();
	expect(sentResponse.status).toBe(202);
	const sent = await readContract(sentResponse);
	expect(sent.signingLinks.map(({ email }) => email)).toEqual([recipient]);
	expect(sent.recipients.map(({ email }) => email)).toEqual([recipient]);
	expect(await readContract(await send())).toEqual(sent);
	expect(deliveries.size).toBe(0);
	loseNextInvitationReceipt();
	await scoped(() => processContractInvitations(env));
	expect(
		(
			await postgres.query("SELECT status FROM contract_invitation_outbox WHERE envelope_id=$1", [
				id,
			])
		).rows,
	).toEqual([{ status: "uncertain" }]);
	const retry = () =>
		request(`/api/contracts/${id}/retry-invitations`, admin("POST", "retry-mail", {}));
	const retried = await retry();
	expect(retried.status).toBe(200);
	const retryBody: unknown = await retried.json();
	expect(retryBody).toMatchObject({ data: { requeued: 1 } });
	expect(await (await retry()).json()).toEqual(retryBody);
	await scoped(() => processContractInvitations(env));
	await scoped(() => processContractInvitations(env));
	expect(deliveries.size).toBe(1);
	expect(attempts).toHaveLength(2);
	expect(new Set(attempts).size).toBe(1);
	expect([...deliveries.values()][0]?.to).toBe(recipient);
	expect((await postgres.query("SELECT status FROM envelopes WHERE id=$1", [id])).rows).toEqual([
		{ status: "sent" },
	]);
	expect((await request(`/api/contracts/${id}/cancel`, admin("POST", "cancel", {}))).status).toBe(
		200,
	);
	expect((await postgres.query("SELECT status FROM envelopes WHERE id=$1", [id])).rows).toEqual([
		{ status: "expired" },
	]);
}, 30_000);

it("deletes only drafts and rejects HTML while managed rendering remains unavailable", async () => {
	const response = await request(
		"/api/contracts/drafts",
		admin("POST", "delete-draft", await upload(definition(false))),
	);
	expect(response.status).toBe(201);
	const { id } = await readContract(response);
	const deletion = () => request(`/api/contracts/${id}`, admin("DELETE", "draft-delete"));
	expect(storedFileCount()).toBe(1);
	const deleted = await deletion();
	expect(deleted.status).toBe(200);
	expect(storedFileCount()).toBe(0);
	const body: unknown = await deleted.json();
	expect(await (await deletion()).json()).toEqual(body);
	expect((await request(`/api/contracts/${id}`, admin("GET", "deleted-detail"))).status).toBe(404);
	expect(
		(
			await request(
				`/api/contracts/${id}/send`,
				admin("POST", "deleted-send", { delivery: "manual" }),
			)
		).status,
	).toBe(404);
	const html = new FormData();
	html.set(
		"pdf",
		new Blob(["<html><body>Agreement</body></html>"], { type: "text/html" }),
		"agreement.html",
	);
	html.set("definition", JSON.stringify(definition(false)));
	const rejected = await request("/api/contracts/drafts", admin("POST", "reject-html", html));
	expect(rejected.status).toBe(400);
	expect(await rejected.json()).toMatchObject({ error: { code: "HTML_RENDERING_UNAVAILABLE" } });
}, 30_000);

it("keeps browser-session CRUD with CSRF within the hosted request budget", async () => {
	for (const delivery of ["manual", "email"] as const) {
		const response = await request(
			"/api/contracts/drafts",
			browserAdmin("POST", `browser-${delivery}`, await upload(definition(false))),
		);
		expect(response.status).toBe(201);
		const { id } = await readContract(response);
		expect(
			(await request(`/api/contracts/${id}`, browserAdmin("GET", "browser-detail"))).status,
		).toBe(200);
		expect(
			(
				await request(
					`/api/contracts/${id}`,
					browserAdmin("PATCH", `browser-patch-${delivery}`, { title: "Browser edit" }),
				)
			).status,
		).toBe(200);
		expect(
			(
				await request(
					`/api/contracts/${id}/pdf`,
					browserAdmin(
						"PUT",
						`browser-replace-${delivery}`,
						await upload(definition(false), "Browser replacement"),
					),
				)
			).status,
		).toBe(200);
		expect(
			(
				await request(
					`/api/contracts/${id}/send`,
					browserAdmin("POST", `browser-send-${delivery}`, { delivery }),
				)
			).status,
		).toBe(delivery === "manual" ? 200 : 202);
	}
}, 30_000);
