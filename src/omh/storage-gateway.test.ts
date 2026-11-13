import { createOmhDocumentsBucket, type OmhStorageEnv } from "./storage";

const env: OmhStorageEnv = {
	OHMYHOST_STORAGE_GATEWAY_URL: "https://storage.example.test",
	OHMYHOST_STORAGE_KEY: "s".repeat(43),
	OHMYHOST_PROJECT_ID: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
	OHMYHOST_ENVIRONMENT_ID: "01ARZ3NDEKTSV4RRFFQ69G5FAW",
};

function frame(value: unknown): Uint8Array {
	const json = new TextEncoder().encode(JSON.stringify(value));
	const result = new Uint8Array(json.length + 4);
	new DataView(result.buffer).setUint32(0, json.length);
	result.set(json, 4);
	return result;
}

it("reads the real gateway batch protocol and validates its terminal frame", async () => {
	const chunks = [
		frame({
			index: 0,
			objectKey: "source.pdf",
			state: "found",
			contentType: "application/pdf",
			contentLength: 3,
			etag: "a".repeat(32),
		}),
		new TextEncoder().encode("pdf"),
		frame({ state: "completed", count: 1 }),
	];
	const fetcher = vi.fn(async (request: Request) => {
		expect(new URL(request.url).pathname).toBe("/v1/downloads/batch");
		return new Response(
			new ReadableStream<Uint8Array>({
				start(controller) {
					for (const chunk of chunks) controller.enqueue(chunk);
					controller.close();
				},
			}),
			{ headers: { "content-type": "application/vnd.ohmyhost.storage-batch.v1" } },
		);
	});
	vi.stubGlobal("fetch", fetcher);
	try {
		const object = await createOmhDocumentsBucket(env).get("source.pdf");
		await expect(object?.text()).resolves.toBe("pdf");
		expect(fetcher).toHaveBeenCalledOnce();
	} finally {
		vi.unstubAllGlobals();
	}
});
