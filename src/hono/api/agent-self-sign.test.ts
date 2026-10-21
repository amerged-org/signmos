import { PDFDocument } from "pdf-lib";
import { agenticApiTokens, agenticSecurityEvents } from "@/db/agentic-access";
import { hashAgenticCredential } from "@/db/agentic-access/request";
import {
	auditEvents,
	emailSendRecords,
	envelopeFields,
	envelopeRecipients,
	envelopes,
	fieldValues,
	finalDocuments,
	signatureProfiles,
	signerTokens,
	sourceDocuments,
} from "@/db/envelope";
import { MAX_SOURCE_PDF_BYTES } from "@/db/envelope/pdf-policy";
import { hashHistoryCredential } from "@/db/history-access/request";
import { historySessions } from "@/db/history-access/table";
import { apiHono } from "@/hono/api";
import { pdfFixtureBytes, pdfFixtureText } from "@/test/pdf-fixtures";
import {
	expectQueuedSelfSignReview,
	expectReplayAndExactTokenPolling,
} from "./agent-self-sign-review-test-assertions";
import {
	agentSelfSignBucket,
	extractPdfVisibleText,
	selfSignRows,
	agentSelfSignTestState as state,
} from "./agent-self-sign-test-db";
import {
	createUploadedSelfSignDraft,
	rawSelfSignToken,
	resetSelfSignTestFixture,
	selfSignCommandHeaders,
	selfSignSecurityEventsOfType,
	selfSignTokenId,
} from "./agent-self-sign-test-support";

vi.mock("@/db/setup", async () => {
	const { getAgentSelfSignTestDb } = await import("./agent-self-sign-test-db");
	return { getDb: getAgentSelfSignTestDb };
});

describe("agent self-sign lifecycle", () => {
	beforeEach(resetSelfSignTestFixture);

	it("queues self-sign completion for human review without signing the document", async () => {
		await expectQueuedSelfSignReview();
	});
	it("replays and polls the same bound pending self-sign command", async () => {
		await expectReplayAndExactTokenPolling();
	});
	it("creates a verified normalized-email self-sign draft without another credential or email", async () => {
		const response = await apiHono.request("/api/v1/documents", {
			method: "POST",
			headers: selfSignCommandHeaders("create-self-sign-1"),
			body: JSON.stringify({ name: "Ada Lovelace" }),
		});
		expect(response.status).toBe(201);
		const body = (await response.json()) as {
			data: { documentId: string; status: string; signingMode: string; sender: unknown };
		};
		expect(body.data).toEqual({
			documentId: expect.any(String),
			status: "draft",
			signingMode: "only_me",
			sender: { name: "Ada Lovelace", email: "ada@example.com" },
			allowedActions: expect.arrayContaining(["upload_source_pdf"]),
		});
		expect(selfSignRows(envelopes)).toEqual([
			expect.objectContaining({
				id: body.data.documentId,
				status: "draft",
				signingMode: "only_me",
				createdBy: "ada@example.com",
				createdByName: "Ada Lovelace",
			}),
		]);
		expect(selfSignRows(envelopeRecipients)).toEqual([
			expect.objectContaining({
				envelopeId: body.data.documentId,
				name: "Ada Lovelace",
				email: "ada@example.com",
				status: "pending",
			}),
		]);
		expect(selfSignRows(auditEvents)).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ eventType: "sender.start.created", message: "ada@example.com" }),
				expect.objectContaining({ eventType: "sender.verified", message: "ada@example.com" }),
			]),
		);
		expect(selfSignRows(agenticSecurityEvents)).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					tokenId: selfSignTokenId,
					documentId: body.data.documentId,
					email: "ada@example.com",
					actorType: "agent",
					eventType: "agentic.document.created",
				}),
			]),
		);
	});
	it("stores one valid source PDF and rejects invalid and exactly over-limit inputs", async () => {
		const created = await apiHono.request("/api/v1/documents", {
			method: "POST",
			headers: selfSignCommandHeaders("create-for-source"),
			body: JSON.stringify({ name: "Ada Lovelace" }),
		});
		const documentId = ((await created.json()) as { data: { documentId: string } }).data.documentId;
		const bucket = agentSelfSignBucket();
		const pdf = pdfFixtureBytes("self sign source");
		const uploaded = await apiHono.request(
			`/api/v1/documents/${documentId}/source-pdf`,
			{
				method: "PUT",
				headers: {
					...selfSignCommandHeaders("upload-source-1", "application/pdf"),
					"x-source-filename": "agreement.pdf",
				},
				body: pdf,
			},
			{ DOCUMENTS_BUCKET: bucket },
		);
		expect(uploaded.status).toBe(201);
		const uploadBody = (await uploaded.json()) as {
			data: { sha256: string; byteSize: number; version: number; downloadUrl: string };
		};
		expect(uploadBody.data).toEqual(
			expect.objectContaining({
				byteSize: pdf.byteLength,
				contentType: "application/pdf",
				originalFilename: "agreement.pdf",
				version: 1,
				sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
				downloadUrl: `/api/v1/documents/${documentId}/source-pdf/content`,
			}),
		);
		expect(selfSignRows(sourceDocuments)).toEqual([
			expect.objectContaining({
				envelopeId: documentId,
				byteSize: pdf.byteLength,
				sha256: uploadBody.data.sha256,
				contentType: "application/pdf",
				version: 1,
				r2Key: `envelopes/${documentId}/source-v1.pdf`,
			}),
		]);
		const replayed = await apiHono.request(
			`/api/v1/documents/${documentId}/source-pdf`,
			{
				method: "PUT",
				headers: {
					...selfSignCommandHeaders("upload-source-1", "application/pdf"),
					"x-source-filename": "agreement.pdf",
				},
				body: pdf,
			},
			{ DOCUMENTS_BUCKET: bucket },
		);
		expect(replayed.status).toBe(201);
		await expect(replayed.json()).resolves.toEqual({ data: uploadBody.data });
		const binaryConflict = await apiHono.request(
			`/api/v1/documents/${documentId}/source-pdf`,
			{
				method: "PUT",
				headers: {
					...selfSignCommandHeaders("upload-source-1", "application/pdf"),
					"x-source-filename": "agreement.pdf",
				},
				body: pdfFixtureText("changed content"),
			},
			{ DOCUMENTS_BUCKET: bucket },
		);
		expect(binaryConflict.status).toBe(409);
		await expect(binaryConflict.json()).resolves.toEqual({
			error: expect.objectContaining({ code: "IDEMPOTENCY_CONFLICT" }),
		});
		expect(selfSignRows(sourceDocuments)).toHaveLength(1);
		expect(state.r2PutCounts.get(`envelopes/${documentId}/source-v1.pdf`)).toBe(1);
		const invalid = await apiHono.request(
			`/api/v1/documents/${documentId}/source-pdf`,
			{
				method: "PUT",
				headers: selfSignCommandHeaders("upload-invalid", "text/plain"),
				body: "not a pdf",
			},
			{ DOCUMENTS_BUCKET: bucket },
		);
		expect(invalid.status).toBe(400);
		await expect(invalid.json()).resolves.toEqual({
			error: expect.objectContaining({ code: "INVALID_SOURCE_PDF", fields: ["body"] }),
		});
		const overLimit = new Uint8Array(MAX_SOURCE_PDF_BYTES + 1);
		overLimit.set(new TextEncoder().encode("%PDF-1.7"));
		const oversized = await apiHono.request(
			`/api/v1/documents/${documentId}/source-pdf`,
			{
				method: "PUT",
				headers: selfSignCommandHeaders("upload-over-limit", "application/pdf"),
				body: overLimit,
			},
			{ DOCUMENTS_BUCKET: bucket },
		);
		expect(oversized.status).toBe(413);
		await expect(oversized.json()).resolves.toEqual({
			error: expect.objectContaining({
				code: "SOURCE_PDF_TOO_LARGE",
				limitBytes: MAX_SOURCE_PDF_BYTES,
				fields: ["body"],
			}),
		});
		expect(selfSignRows(sourceDocuments)).toHaveLength(1);
	});
	it("validates reusable typed/drawn profiles and isolates them to the verified email", async () => {
		const bucket = agentSelfSignBucket();
		const documentId = await createUploadedSelfSignDraft("profile", bucket);
		const withoutConsent = await apiHono.request(
			`/api/v1/documents/${documentId}/signature-profiles`,
			{
				method: "POST",
				headers: selfSignCommandHeaders("profile-no-consent"),
				body: JSON.stringify({
					profile: { kind: "typed", label: "Ada", typedText: "Ada", typedFont: "cursive" },
					rememberSignature: false,
				}),
			},
		);
		expect(withoutConsent.status).toBe(400);
		await expect(withoutConsent.json()).resolves.toEqual({
			error: expect.objectContaining({ code: "SIGNATURE_REUSE_CONSENT_REQUIRED" }),
		});
		expect(selfSignRows(signatureProfiles)).toHaveLength(0);
		const typed = await apiHono.request(`/api/v1/documents/${documentId}/signature-profiles`, {
			method: "POST",
			headers: selfSignCommandHeaders("profile-typed"),
			body: JSON.stringify({
				profile: {
					kind: "typed",
					label: "Ada reusable",
					typedText: "Ada Lovelace",
					typedFont: "cursive",
				},
				rememberSignature: true,
			}),
		});
		expect(typed.status).toBe(201);
		const typedReplay = await apiHono.request(
			`/api/v1/documents/${documentId}/signature-profiles`,
			{
				method: "POST",
				headers: selfSignCommandHeaders("profile-typed"),
				body: JSON.stringify({
					profile: {
						kind: "typed",
						label: "Ada reusable",
						typedText: "Ada Lovelace",
						typedFont: "cursive",
					},
					rememberSignature: true,
				}),
			},
		);
		expect(typedReplay.status).toBe(201);
		expect(selfSignRows(signatureProfiles)).toHaveLength(1);
		state.now = new Date("2026-07-17T10:01:00.000Z");
		const drawn = await apiHono.request(`/api/v1/documents/${documentId}/signature-profiles`, {
			method: "POST",
			headers: selfSignCommandHeaders("profile-drawn"),
			body: JSON.stringify({
				profile: { kind: "drawn", label: "Ada drawn", svgPath: "M 1 1 L 40 20" },
				rememberSignature: true,
			}),
		});
		expect(drawn.status).toBe(201);
		expect(selfSignRows(signatureProfiles)).toHaveLength(2);
		expect(
			selfSignRows(signatureProfiles).every((row) => row.createdBy === "ada@example.com"),
		).toBe(true);
		const selected = await apiHono.request(
			`/api/v1/documents/${documentId}/signature-profiles/selected`,
			{ headers: selfSignCommandHeaders("unused-read-key") },
		);
		expect(selected.status).toBe(200);
		await expect(selected.json()).resolves.toEqual({
			data: expect.objectContaining({ kind: "drawn", createdBy: "ada@example.com" }),
		});
		const outsiderToken = "signmos_profile_outsider_token";
		selfSignRows(agenticApiTokens).push({
			id: "a0000000-0000-4000-8000-000000000002",
			email: "outsider@example.com",
			name: "Outsider",
			tokenHash: await hashAgenticCredential(outsiderToken),
			tokenHint: "signmos_...ider",
			status: "active",
			activeSlot: 1,
			lastUsedAt: null,
			revokedAt: null,
			createdAt: state.now,
		});
		const isolated = await apiHono.request(
			`/api/v1/documents/${documentId}/signature-profiles/selected`,
			{ headers: { authorization: `Bearer ${outsiderToken}`, "x-now": state.now.toISOString() } },
		);
		expect(isolated.status).toBe(404);
		await expect(isolated.json()).resolves.toEqual({
			error: expect.objectContaining({ code: "AGENT_DOCUMENT_NOT_FOUND" }),
		});
	});

	it("prepares, reviews, repositions, completes, polls, and downloads a self-signed artifact", async () => {
		const bucket = agentSelfSignBucket();
		const documentId = await createUploadedSelfSignDraft("complete", bucket);
		const prepared = await apiHono.request(`/api/v1/documents/${documentId}/fields/defaults`, {
			method: "POST",
			headers: selfSignCommandHeaders("default-fields"),
			body: JSON.stringify({ page: 1 }),
		});
		expect(prepared.status).toBe(201);
		const preparedBody = (await prepared.json()) as {
			data: { status: string; fields: Array<{ id: string; type: string }> };
		};
		expect(preparedBody.data.status).toBe("sent");
		expect(preparedBody.data.fields).toEqual([
			expect.objectContaining({ type: "signature", page: 1, x: 360, y: 628 }),
			expect.objectContaining({ type: "date", page: 1, x: 420, y: 688 }),
		]);
		expect(selfSignRows(signerTokens)).toHaveLength(1);
		expect(JSON.stringify(preparedBody)).not.toMatch(/signerToken|signingUrl|\/signing\//);
		const preparedReplay = await apiHono.request(
			`/api/v1/documents/${documentId}/fields/defaults`,
			{
				method: "POST",
				headers: selfSignCommandHeaders("default-fields"),
				body: JSON.stringify({ page: 1 }),
			},
		);
		expect(preparedReplay.status).toBe(201);
		await expect(preparedReplay.json()).resolves.toEqual(preparedBody);
		expect(selfSignRows(envelopeFields)).toHaveLength(2);
		expect(selfSignRows(signerTokens)).toHaveLength(1);
		expect(selfSignRows(emailSendRecords)).toHaveLength(1);
		expect(selfSignSecurityEventsOfType("agentic.fields.prepared")).toHaveLength(1);

		const task = await apiHono.request(`/api/v1/documents/${documentId}/signing-task`, {
			headers: selfSignCommandHeaders("unused-task-key"),
		});
		expect(task.status).toBe(200);
		const taskBody = (await task.json()) as {
			data: {
				sourceDocument: { downloadUrl: string };
				fields: Array<{ id: string; type: string }>;
			};
		};
		expect(taskBody.data.sourceDocument.downloadUrl).toBe(
			`/api/v1/documents/${documentId}/source-pdf/content`,
		);
		expect(taskBody.data.fields).toHaveLength(2);
		const signatureField = taskBody.data.fields.find((field) => field.type === "signature");
		expect(signatureField).toBeTruthy();

		const repositioned = await apiHono.request(
			`/api/v1/documents/${documentId}/fields/${signatureField?.id}`,
			{
				method: "PATCH",
				headers: selfSignCommandHeaders("reposition-field"),
				body: JSON.stringify({ page: 1, x: 96, y: 192 }),
			},
		);
		expect(repositioned.status).toBe(200);
		await expect(repositioned.json()).resolves.toEqual({
			data: expect.objectContaining({ id: signatureField?.id, x: 96, y: 192 }),
		});
		const repositionReplay = await apiHono.request(
			`/api/v1/documents/${documentId}/fields/${signatureField?.id}`,
			{
				method: "PATCH",
				headers: selfSignCommandHeaders("reposition-field"),
				body: JSON.stringify({ page: 1, x: 96, y: 192 }),
			},
		);
		expect(repositionReplay.status).toBe(200);
		expect(selfSignSecurityEventsOfType("agentic.field.repositioned")).toHaveLength(1);

		const completed = await apiHono.request(
			`/api/v1/documents/${documentId}/complete`,
			{
				method: "POST",
				headers: selfSignCommandHeaders("complete-self-sign"),
				body: JSON.stringify({
					signature: { kind: "typed", typedText: "Ada Lovelace", typedFont: "cursive" },
					rememberSignature: false,
					date: "2099-12-31",
				}),
			},
			{ DOCUMENTS_BUCKET: bucket },
		);
		expect(completed.status).toBe(202);
		const pending = (await completed.json()) as { data: { reviewUrl: string } };
		const rawSession = "self-sign-lifecycle-review-session";
		selfSignRows(historySessions).push({
			id: "b6000000-0000-4000-8000-000000000001",
			linkId: crypto.randomUUID(),
			email: "ada@example.com",
			sessionHash: await hashHistoryCredential(rawSession),
			status: "active",
			expiresAt: new Date(state.now.getTime() + 60 * 60 * 1000),
			revokedAt: null,
			createdAt: state.now,
		});
		const reviewPath = new URL(pending.data.reviewUrl).pathname.replace(
			"/human-review/",
			"/api/history/human-reviews/",
		);
		const approved = await apiHono.request(
			`${reviewPath}/decision`,
			{
				method: "POST",
				headers: {
					cookie: `signmos_history_session=${rawSession}`,
					"content-type": "application/json",
					origin: "http://localhost",
					"x-now": state.now.toISOString(),
				},
				body: JSON.stringify({ decision: "approve" }),
			},
			{ DOCUMENTS_BUCKET: bucket },
		);
		expect(approved.status).toBe(200);
		const completedBody = await approved.json();
		expect(completedBody).toEqual({
			data: expect.objectContaining({
				status: "completed",
				result: expect.objectContaining({
					envelopeId: documentId,
					envelopeStatus: "completed",
				}),
			}),
		});
		const completedReplay = await apiHono.request(
			`/api/v1/documents/${documentId}/complete`,
			{
				method: "POST",
				headers: selfSignCommandHeaders("complete-self-sign"),
				body: JSON.stringify({
					signature: { kind: "typed", typedText: "Ada Lovelace", typedFont: "cursive" },
					rememberSignature: false,
					date: "2099-12-31",
				}),
			},
			{ DOCUMENTS_BUCKET: bucket },
		);
		expect(completedReplay.status).toBe(200);
		await expect(completedReplay.json()).resolves.toEqual(completedBody);
		expect(selfSignRows(fieldValues)).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ value: "Ada Lovelace" }),
				expect.objectContaining({ value: "2026-07-17" }),
			]),
		);
		expect(selfSignRows(fieldValues)).toHaveLength(2);
		expect(selfSignRows(finalDocuments)).toHaveLength(1);
		expect(selfSignSecurityEventsOfType("agentic.self_sign.completed")).toHaveLength(1);
		const finalKey = selfSignRows(finalDocuments)[0]?.r2Key;
		expect(typeof finalKey).toBe("string");
		expect(typeof finalKey === "string" ? state.r2PutCounts.get(finalKey) : undefined).toBe(1);
		const finalBytes = typeof finalKey === "string" ? state.r2Objects.get(finalKey) : undefined;
		expect(finalBytes).toBeTruthy();
		expect(extractPdfVisibleText(finalBytes ?? new Uint8Array())).toContain("Ada Lovelace");
		expect(extractPdfVisibleText(finalBytes ?? new Uint8Array())).toContain("AUDIT CERTIFICATE");
		expect(extractPdfVisibleText(finalBytes ?? new Uint8Array())).toContain(
			"Certificate checksum:",
		);

		for (const path of [
			`/api/v1/documents/${documentId}`,
			`/api/v1/documents/${documentId}/status`,
			`/api/v1/documents/${documentId}/history`,
		]) {
			const response = await apiHono.request(path, {
				headers: selfSignCommandHeaders("unused-read"),
			});
			expect(response.status, path).toBe(200);
			expect(JSON.stringify(await response.json())).not.toMatch(/signmos_|signerToken|r2Key/);
		}
		const finalPdf = await apiHono.request(
			`/api/v1/documents/${documentId}/pdf`,
			{ headers: selfSignCommandHeaders("unused-final-read") },
			{ DOCUMENTS_BUCKET: bucket },
		);
		expect(finalPdf.status).toBe(200);
		expect(finalPdf.headers.get("content-type")).toBe("application/pdf");
		expect(await PDFDocument.load(await finalPdf.arrayBuffer())).toBeTruthy();
		expect(selfSignRows(envelopeFields)).toEqual(
			expect.arrayContaining([expect.objectContaining({ id: signatureField?.id, x: 96, y: 192 })]),
		);
		expect(JSON.stringify([...state.rows.values()])).not.toContain(rawSelfSignToken);
	});
});
