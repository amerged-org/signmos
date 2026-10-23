import { createOmhDocumentsBucket, type OmhStorageEnv } from "./storage";

const boundary = vi.hoisted(() => ({
	createClient: vi.fn(),
	read: vi.fn(),
	upload: vi.fn(),
	delete: vi.fn(),
}));

vi.mock("@ohmyhost/customer-runtime/storage", () => ({
	createPrivateStorageClient: boundary.createClient,
}));

/** workerd constructs a Request only for redirect "follow" or "manual"; Node also accepts "error". */
function stubWorkersRequestConstructor() {
	const NodeRequest = Request;
	class WorkersRequest extends NodeRequest {
		constructor(input: RequestInfo | URL, init?: RequestInit) {
			if (init?.redirect === "error")
				throw new TypeError('Invalid redirect value, must be one of "follow" or "manual"');
			super(input, init);
		}
	}
	vi.stubGlobal("Request", WorkersRequest);
}

const env: OmhStorageEnv = {
	OHMYHOST_STORAGE_GATEWAY: { fetch: vi.fn() },
	OHMYHOST_STORAGE_GATEWAY_URL: "https://private-storage.invalid",
	OHMYHOST_STORAGE_KEY: "private-key",
	OHMYHOST_PROJECT_ID: "project",
	OHMYHOST_ENVIRONMENT_ID: "environment",
};

describe("OMH private document storage", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		boundary.createClient.mockReturnValue({
			createSignedRead: boundary.read,
			upload: boundary.upload,
			deleteObject: boundary.delete,
			deleteMany: boundary.delete,
		});
		boundary.upload.mockResolvedValue({ state: "completed", transferId: "transfer" });
		boundary.delete.mockImplementation(
			async ({ objects }: { objects: Array<{ objectKey: string }> }) =>
				objects.map(({ objectKey }) => ({ state: "completed", objectKey })),
		);
	});

	afterEach(() => vi.unstubAllGlobals());

	it("fetches authorized private bytes server-side and preserves a streaming response", async () => {
		stubWorkersRequestConstructor();
		const fetchObject = vi.fn().mockResolvedValue(
			new Response("contract", {
				headers: { "content-type": "application/pdf", etag: '"version-one"' },
			}),
		);
		vi.stubGlobal("fetch", fetchObject);
		boundary.read.mockResolvedValue({
			url: "https://signed-storage.invalid/private-object?signature=secret",
			requiredHeaders: { "x-object-proof": "proof" },
			expectedContentLength: 8,
		});

		const bucket = createOmhDocumentsBucket(env);
		const object = await bucket.get("envelopes/one/source-v1.pdf");
		expect(object?.size).toBe(8);
		expect(object?.httpMetadata?.contentType).toBe("application/pdf");
		expect(object?.body).toBeInstanceOf(ReadableStream);
		expect(object?.bodyUsed).toBe(false);
		await expect(object?.text()).resolves.toBe("contract");
		expect(object?.bodyUsed).toBe(true);
		expect(boundary.read).toHaveBeenCalledWith("envelopes/one/source-v1.pdf");
		const request = fetchObject.mock.calls[0]?.[0] as Request;
		expect(request.redirect).toBe("manual");
		expect(request.headers.get("x-object-proof")).toBe("proof");
		expect(request.headers.get("authorization")).toBeNull();
		expect(boundary.createClient).toHaveBeenCalledWith(
			expect.objectContaining({
				endpoint: env.OHMYHOST_STORAGE_GATEWAY_URL,
				key: env.OHMYHOST_STORAGE_KEY,
				projectId: env.OHMYHOST_PROJECT_ID,
				environmentId: env.OHMYHOST_ENVIRONMENT_ID,
			}),
		);
	});

	it("refuses a redirecting signed URL instead of following it", async () => {
		stubWorkersRequestConstructor();
		const fetchObject = vi
			.fn()
			.mockResolvedValue(
				new Response(null, { status: 302, headers: { location: "https://elsewhere.invalid/" } }),
			);
		vi.stubGlobal("fetch", fetchObject);
		boundary.read.mockResolvedValue({
			url: "https://signed-storage.invalid/private-object?signature=secret",
			requiredHeaders: {},
			expectedContentLength: null,
		});
		await expect(createOmhDocumentsBucket(env).get("contract.pdf")).rejects.toThrow(
			"Private document read failed",
		);
		expect(fetchObject).toHaveBeenCalledOnce();
	});

	it("maps an authoritative missing object to null and propagates storage failures", async () => {
		const bucket = createOmhDocumentsBucket(env);
		boundary.read.mockRejectedValueOnce(
			Object.assign(new Error("missing"), { code: "storage_object_not_found" }),
		);
		await expect(bucket.get("missing.pdf")).resolves.toBeNull();
		boundary.read.mockRejectedValueOnce(
			Object.assign(new Error("unavailable"), { code: "gateway_unavailable" }),
		);
		await expect(bucket.get("contract.pdf")).rejects.toThrow("unavailable");
	});

	it("reuses the exact upload receipt for identical bytes, but cannot reuse it for changed bytes", async () => {
		const bucket = createOmhDocumentsBucket(env);
		const bytes = new Uint8Array([1, 2, 3]);
		await bucket.put("contract.pdf", bytes, { httpMetadata: { contentType: "application/pdf" } });
		await bucket.put("contract.pdf", bytes);
		await bucket.put("contract.pdf", new Uint8Array([3, 2, 1]));
		const first = boundary.upload.mock.calls[0]?.[0];
		const second = boundary.upload.mock.calls[1]?.[0];
		const changed = boundary.upload.mock.calls[2]?.[0];
		expect(first).toEqual(second);
		expect(first.idempotencyKey).toMatch(/^upload:[a-f0-9]{32}:[a-f0-9]{64}$/);
		expect(changed.idempotencyKey).not.toBe(first.idempotencyKey);
	});

	it("preserves view offsets and does not acknowledge an uncompleted upload", async () => {
		const bucket = createOmhDocumentsBucket(env);
		boundary.upload.mockResolvedValueOnce({ state: "pending", transferId: "transfer" });
		await expect(
			bucket.put("contract.pdf", new Uint8Array([9, 1, 2, 9]).subarray(1, 3)),
		).rejects.toMatchObject({ code: "storage_upload_pending", retryable: true });
		expect(boundary.upload.mock.calls[0]?.[0].bytes).toEqual(new Uint8Array([1, 2]));
	});

	it("uses stable, separate deletion receipts for every private object", async () => {
		const bucket = createOmhDocumentsBucket(env);
		await bucket.delete(["source.pdf", "final.pdf"]);
		await bucket.delete("source.pdf");
		const [first, second] = boundary.delete.mock.calls[0]?.[0].objects ?? [];
		const replay = boundary.delete.mock.calls[1]?.[0].objects[0];
		expect(first).toEqual(replay);
		expect(first.idempotencyKey).toMatch(/^delete:[a-f0-9]{64}$/);
		expect(first.idempotencyKey).not.toBe(second.idempotencyKey);
	});

	/**
	 * A name is retained before its upload, so an attempt that failed before the platform reserved
	 * the name leaves a name that was never stored. Its deletion answers object_not_found, and that
	 * must not keep the contract's other files from being erased.
	 */
	it("treats a name that was never stored as already deleted, but not a gateway failure", async () => {
		boundary.delete.mockResolvedValueOnce([
			{ state: "failed", objectKey: "final.pdf", code: "object_not_found", retryable: false },
			{ state: "completed", objectKey: "source.pdf", deletionId: "deletion" },
		]);
		await expect(
			createOmhDocumentsBucket(env).delete(["final.pdf", "source.pdf"]),
		).resolves.toBeUndefined();
		boundary.delete.mockResolvedValueOnce([
			{
				state: "failed",
				objectKey: "final.pdf",
				code: "storage_gateway_unavailable",
				retryable: true,
			},
		]);
		await expect(createOmhDocumentsBucket(env).delete("final.pdf")).rejects.toMatchObject({
			code: "storage_gateway_unavailable",
			retryable: true,
		});
	});

	it("does not acknowledge a partially completed private-file deletion", async () => {
		boundary.delete.mockResolvedValueOnce([
			{ state: "pending", objectKey: "source.pdf", retryAt: "2026-10-21T09:01:00Z" },
		]);
		await expect(createOmhDocumentsBucket(env).delete("source.pdf")).rejects.toMatchObject({
			code: "storage_delete_pending",
			retryable: true,
		});
	});
});
