import { queryOptions } from "@tanstack/react-query";
import { z } from "zod";

export const consoleKeys = {
	session: ["amerged", "session"] as const,
	contracts: ["amerged", "contracts"] as const,
	tokens: ["amerged", "tokens"] as const,
};

const sessionSchema = z.object({
	authenticated: z.boolean(),
	email: z.string().optional(),
	csrfToken: z.string().optional(),
	expiresAt: z.string().optional(),
});

const recipientSchema = z.object({
	name: z.string().optional(),
	email: z.string(),
	status: z.string().optional(),
});

export const contractSchema = z.object({
	id: z.string(),
	title: z.string(),
	status: z.string(),
	recipients: z.array(recipientSchema),
	createdAt: z.string(),
	completedAt: z.string().nullable().optional(),
	downloadUrl: z.string().nullable().optional(),
});

export const tokenSchema = z.object({
	id: z.string(),
	name: z.string(),
	hint: z.string(),
	status: z.string(),
	createdAt: z.string(),
	lastUsedAt: z.string().nullable().optional(),
	revokedAt: z.string().nullable().optional(),
});

export type ConsoleSession = z.infer<typeof sessionSchema>;
export type Contract = z.infer<typeof contractSchema>;
export type ApiToken = z.infer<typeof tokenSchema>;

export class ConsoleRequestError extends Error {
	constructor(
		readonly status: number,
		message: string,
	) {
		super(message);
		this.name = "ConsoleRequestError";
	}
}

export async function consoleRequest(path: string, init?: RequestInit): Promise<unknown> {
	const response = await fetch(path, { credentials: "same-origin", cache: "no-store", ...init });
	if (response.status === 204) return undefined;
	const body: unknown = await response.json().catch(() => undefined);
	if (!response.ok) {
		const parsed = z.object({ error: z.object({ message: z.string() }) }).safeParse(body);
		throw new ConsoleRequestError(
			response.status,
			response.status === 401
				? "Deine Sitzung ist abgelaufen. Bitte melde dich erneut an."
				: parsed.success
					? parsed.data.error.message
					: "Die Anfrage konnte nicht abgeschlossen werden. Bitte versuche es erneut.",
		);
	}
	return body;
}

export function mutationHeaders(csrfToken: string): Record<string, string> {
	return { "content-type": "application/json", "X-CSRF-Token": csrfToken };
}

export const sessionOptions = queryOptions({
	queryKey: consoleKeys.session,
	queryFn: async () => {
		const body = await consoleRequest("/api/auth/session");
		return z.object({ data: sessionSchema }).parse(body).data;
	},
	retry: false,
	staleTime: 30_000,
	refetchOnWindowFocus: true,
});

export const contractsOptions = queryOptions({
	queryKey: consoleKeys.contracts,
	queryFn: async () => {
		const body = await consoleRequest("/api/contracts");
		return z.object({ data: z.array(contractSchema) }).parse(body).data;
	},
	retry: false,
	refetchInterval: 30_000,
});

export function formatDate(value: string): string {
	const date = new Date(value);
	return Number.isNaN(date.getTime())
		? "–"
		: new Intl.DateTimeFormat("de-DE", { dateStyle: "medium" }).format(date);
}
