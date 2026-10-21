import { createPrivateStorageClient } from "@ohmyhost/customer-runtime/storage";

export interface OmhStorageEnv {
	OHMYHOST_STORAGE_GATEWAY: { fetch(request: Request): Promise<Response> };
	OHMYHOST_STORAGE_GATEWAY_URL: string;
	OHMYHOST_STORAGE_KEY: string;
	OHMYHOST_PROJECT_ID: string;
	OHMYHOST_ENVIRONMENT_ID: string;
}

/** The existing document domain uses only these R2-compatible operations. */
export function createOmhDocumentsBucket(env: OmhStorageEnv): R2Bucket {
	const storage = createPrivateStorageClient({
		endpoint: env.OHMYHOST_STORAGE_GATEWAY_URL,
		key: env.OHMYHOST_STORAGE_KEY,
		projectId: env.OHMYHOST_PROJECT_ID,
		environmentId: env.OHMYHOST_ENVIRONMENT_ID,
		fetch: (request) => env.OHMYHOST_STORAGE_GATEWAY.fetch(request),
		capabilityFetch: (request) => fetch(request),
	});

	const bucket = {
		async get(key: string): Promise<R2ObjectBody | null> {
			let capability: Awaited<ReturnType<typeof storage.createSignedRead>>;
			try {
				capability = await storage.createSignedRead(key);
			} catch (error) {
				if (hasCode(error, "storage_object_not_found")) return null;
				throw error;
			}
			const response = await fetch(
				new Request(capability.url, {
					headers: capability.requiredHeaders,
					redirect: "error",
					signal: AbortSignal.timeout(30_000),
				}),
			);
			if (response.status === 404) return null;
			if (!response.ok || !response.body) throw new Error("Private document read failed");
			const size =
				capability.expectedContentLength ?? Number(response.headers.get("content-length"));
			const metadata = objectMetadata(
				key,
				Number.isSafeInteger(size) && size >= 0 ? size : 0,
				response.headers,
			);
			return {
				...metadata,
				writeHttpMetadata: (headers) => metadata.writeHttpMetadata(headers),
				get body() {
					return response.body as ReadableStream;
				},
				get bodyUsed() {
					return response.bodyUsed;
				},
				arrayBuffer: () => response.arrayBuffer(),
				bytes: async () => new Uint8Array(await response.arrayBuffer()),
				text: () => response.text(),
				json: <T>() => response.json() as Promise<T>,
				blob: () => response.blob(),
			};
		},
		async put(
			key: string,
			value: ArrayBuffer | ArrayBufferView | string | null | Blob | ReadableStream,
			options?: R2PutOptions,
		): Promise<R2Object> {
			const bytes = await uploadBytes(value);
			const contentType =
				options?.httpMetadata instanceof Headers
					? (options.httpMetadata.get("content-type") ?? "application/pdf")
					: (options?.httpMetadata?.contentType ?? "application/pdf");
			const [keyHash, contentHash] = await Promise.all([
				digest(new TextEncoder().encode(key)),
				digest(bytes),
			]);
			const result = await storage.upload({
				objectKey: key,
				idempotencyKey: `upload:${keyHash.slice(0, 32)}:${contentHash}`,
				contentType,
				bytes,
			});
			if (result.state !== "completed") {
				throw Object.assign(
					new Error("Private document upload is still settling; repeat the same request"),
					{
						code: "storage_upload_pending",
						retryable: true,
					},
				);
			}
			return objectMetadata(key, bytes.byteLength, new Headers({ "content-type": contentType }));
		},
		async delete(keys: string | string[]): Promise<void> {
			const uniqueKeys = [...new Set(Array.isArray(keys) ? keys : [keys])];
			for (let offset = 0; offset < uniqueKeys.length; offset += 4000) {
				const objects = await Promise.all(
					uniqueKeys.slice(offset, offset + 4000).map(async (key) => ({
						objectKey: key,
						idempotencyKey: `delete:${await digest(new TextEncoder().encode(key))}`,
					})),
				);
				const results = await storage.deleteMany({ objects });
				const incomplete = results.find((result) => result.state !== "completed");
				if (incomplete) {
					throw Object.assign(
						new Error("Private document deletion has not completed; repeat the same request"),
						{
							code: incomplete.state === "pending" ? "storage_delete_pending" : incomplete.code,
							retryable: incomplete.state === "pending" || incomplete.retryable,
						},
					);
				}
			}
		},
	};
	// This adapter intentionally implements the document domain's get/put/delete port only.
	// It never receives or forwards a raw platform bucket binding.
	return bucket as unknown as R2Bucket;
}

function objectMetadata(key: string, size: number, headers: Headers): R2Object {
	const httpMetadata = {
		...(headers.get("content-type")
			? { contentType: headers.get("content-type") ?? undefined }
			: {}),
		...(headers.get("content-disposition")
			? { contentDisposition: headers.get("content-disposition") ?? undefined }
			: {}),
	};
	const httpEtag = headers.get("etag") ?? '""';
	return {
		key,
		size,
		version: "",
		etag: httpEtag.replace(/^"|"$/g, ""),
		httpEtag,
		uploaded: new Date(headers.get("last-modified") ?? 0),
		storageClass: "Standard",
		checksums: { toJSON: () => ({}) },
		httpMetadata,
		writeHttpMetadata(target) {
			if (httpMetadata.contentType) target.set("content-type", httpMetadata.contentType);
			if (httpMetadata.contentDisposition)
				target.set("content-disposition", httpMetadata.contentDisposition);
		},
	};
}

async function uploadBytes(
	value: ArrayBuffer | ArrayBufferView | string | null | Blob | ReadableStream,
): Promise<Uint8Array> {
	if (value === null) return new Uint8Array();
	if (typeof value === "string") return new TextEncoder().encode(value);
	if (value instanceof ArrayBuffer) return new Uint8Array(value);
	if (ArrayBuffer.isView(value))
		return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
	if (value instanceof Blob) return new Uint8Array(await value.arrayBuffer());
	return new Uint8Array(await new Response(value).arrayBuffer());
}

async function digest(bytes: Uint8Array): Promise<string> {
	const buffer = new Uint8Array(bytes).buffer;
	return [...new Uint8Array(await crypto.subtle.digest("SHA-256", buffer))]
		.map((byte) => byte.toString(16).padStart(2, "0"))
		.join("");
}

function hasCode(error: unknown, code: string): boolean {
	return error instanceof Error && "code" in error && error.code === code;
}
