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
		readonly code?: string,
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
		const parsed = z
			.object({ error: z.object({ message: z.string(), code: z.string().optional() }) })
			.safeParse(body);
		throw new ConsoleRequestError(
			response.status,
			response.status === 401
				? "Deine Sitzung ist abgelaufen. Bitte melde dich erneut an."
				: parsed.success
					? parsed.data.error.message
					: "Die Anfrage konnte nicht abgeschlossen werden. Bitte versuche es erneut.",
			parsed.success ? parsed.data.error.code : undefined,
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

export function formatDate(value: string, language: "de" | "en" | "nl" = "de"): string {
	const date = new Date(value);
	return Number.isNaN(date.getTime())
		? "–"
		: new Intl.DateTimeFormat({ de: "de-DE", en: "en-GB", nl: "nl-NL" }[language], {
				dateStyle: "medium",
			}).format(date);
}

export function consoleErrorMessage(error: unknown, language: "de" | "en" | "nl"): string {
	const messages = {
		de: {
			session: "Sitzung abgelaufen. Bitte erneut anmelden.",
			size: "Die PDF ist zu groß.",
			rate: "Bitte warte kurz und versuche es erneut.",
			limit: "Maximal fünf Schlüssel. Bitte zuerst einen widerrufen.",
			missing: "Schlüssel nicht gefunden.",
			pdf: "Bitte eine gültige, unverschlüsselte PDF auswählen.",
			recipient: "Bitte einen anderen Empfänger wählen.",
			delivery: "Versand unklar. Bitte den Vertragsstatus prüfen, bevor du erneut sendest.",
			conflict: "Diese Anfrage wurde bereits mit anderen Daten verwendet.",
			fallback: "Das hat nicht geklappt. Bitte erneut versuchen.",
		},
		en: {
			session: "Session expired. Please sign in again.",
			size: "The PDF is too large.",
			rate: "Please wait and try again.",
			limit: "Maximum five keys. Revoke one first.",
			missing: "Key not found.",
			pdf: "Choose a valid, unencrypted PDF.",
			recipient: "Choose a different recipient.",
			delivery: "Delivery is uncertain. Check the contract status before sending again.",
			conflict: "This request was already used with different data.",
			fallback: "Something went wrong. Please try again.",
		},
		nl: {
			session: "Sessie verlopen. Log opnieuw in.",
			size: "De PDF is te groot.",
			rate: "Wacht even en probeer opnieuw.",
			limit: "Maximaal vijf sleutels. Trek er eerst één in.",
			missing: "Sleutel niet gevonden.",
			pdf: "Kies een geldige, onbeveiligde PDF.",
			recipient: "Kies een andere ontvanger.",
			delivery: "Verzending onzeker. Controleer de contractstatus voordat je opnieuw verstuurt.",
			conflict: "Deze aanvraag is al met andere gegevens gebruikt.",
			fallback: "Er ging iets mis. Probeer het opnieuw.",
		},
	}[language];
	if (error instanceof ConsoleRequestError) {
		if (error.status === 401) return messages.session;
		if (error.status === 413 || error.code === "SOURCE_PDF_TOO_LARGE") return messages.size;
		if (error.status === 429) return messages.rate;
		if (error.code === "API_TOKEN_LIMIT") return messages.limit;
		if (error.code === "API_TOKEN_NOT_FOUND") return messages.missing;
		if (error.code === "INVALID_SOURCE_PDF") return messages.pdf;
		if (error.code === "EXTERNAL_RECIPIENT_REQUIRED") return messages.recipient;
		if (error.code === "EMAIL_DELIVERY_FAILED") return messages.delivery;
		if (error.code === "IDEMPOTENCY_CONFLICT") return messages.conflict;
		if (error.code === "IDEMPOTENCY_REQUEST_IN_PROGRESS") return messages.rate;
	}
	return messages.fallback;
}
