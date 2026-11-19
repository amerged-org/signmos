import { useForm } from "@tanstack/react-form";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Copy, KeyRound, Plus, Trash2 } from "lucide-react";
import { useState } from "react";
import { z } from "zod";
import {
	type ApiToken,
	consoleErrorMessage,
	consoleKeys,
	consoleRequest,
	formatDate,
	mutationHeaders,
	tokenSchema,
} from "@/components/console/console-api";
import { EmptyState } from "@/components/patterns/empty-state";
import { LoadingText } from "@/components/patterns/loading-text";
import { Panel, PanelDescription, PanelTitle } from "@/components/patterns/panel";
import { StatusBadge } from "@/components/patterns/status-badge";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogClose,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { MAX_SOURCE_PDF_BYTES, MAX_SOURCE_PDF_PAGES } from "@/db/envelope/pdf-policy-limits";
import { useLanguage } from "@/lib/i18n";

interface ApiAccessProps {
	csrfToken: string;
}

const copy = {
	de: {
		title: "API-Schlüssel",
		loading: "Schlüssel werden geladen…",
		loadError: "Schlüssel konnten nicht geladen werden.",
		empty: "Noch keine Schlüssel",
		name: "Name",
		required: "Name eingeben.",
		create: "Schlüssel erstellen",
		creating: "Wird erstellt…",
		security: "Schlüssel nur vertrauenswürdigen Anwendungen geben.",
		createError: "Schlüssel konnte nicht erstellt werden.",
		newKey: "Neuer Schlüssel",
		oneTime: "Nur jetzt sichtbar. Bitte sicher speichern.",
		copyKey: "Schlüssel kopieren",
		hide: "Gespeichert",
		api: "API verwenden",
		apiDescription: "PDF und Empfänger per API senden.",
		copyExample: "Beispiel kopieren",
		example: "Beispiel anzeigen",
		limits: (mb: number, pages: number) => `PDF: bis ${mb} MB und ${pages} Seiten.`,
		docs: "OpenAPI öffnen",
		list: "Verträge",
		download: "Signiertes PDF",
		copyKeyOk: "Schlüssel kopiert.",
		copyExampleOk: "Beispiel kopiert.",
		copyFailed: "Bitte manuell kopieren.",
		revokeTitle: "Schlüssel widerrufen?",
		revokeDescription: (name: string) => `„${name}“ verliert sofort den Zugriff.`,
		cancel: "Abbrechen",
		revoke: "Widerrufen",
		revoking: "Wird widerrufen…",
		active: "Aktiv",
		revoked: "Widerrufen",
		created: "Erstellt",
		lastUsed: "Zuletzt genutzt",
		revokeLabel: (name: string) => `${name} widerrufen`,
	},
	en: {
		title: "API keys",
		loading: "Loading keys…",
		loadError: "Could not load keys.",
		empty: "No keys yet",
		name: "Name",
		required: "Enter a name.",
		create: "Create key",
		creating: "Creating…",
		security: "Only share keys with trusted applications.",
		createError: "Could not create key.",
		newKey: "New key",
		oneTime: "Shown only once. Store it safely.",
		copyKey: "Copy key",
		hide: "Saved",
		api: "Use the API",
		apiDescription: "Send a PDF and recipient via API.",
		copyExample: "Copy example",
		example: "Show example",
		limits: (mb: number, pages: number) => `PDF: up to ${mb} MB and ${pages} pages.`,
		docs: "OpenAPI reference",
		list: "Contracts",
		download: "Signed PDF",
		copyKeyOk: "Key copied.",
		copyExampleOk: "Example copied.",
		copyFailed: "Please copy manually.",
		revokeTitle: "Revoke key?",
		revokeDescription: (name: string) => `“${name}” will immediately lose access.`,
		cancel: "Cancel",
		revoke: "Revoke",
		revoking: "Revoking…",
		active: "Active",
		revoked: "Revoked",
		created: "Created",
		lastUsed: "Last used",
		revokeLabel: (name: string) => `Revoke ${name}`,
	},
	nl: {
		title: "API-sleutels",
		loading: "Sleutels laden…",
		loadError: "Sleutels laden mislukt.",
		empty: "Nog geen sleutels",
		name: "Naam",
		required: "Vul een naam in.",
		create: "Sleutel maken",
		creating: "Bezig…",
		security: "Deel sleutels alleen met vertrouwde toepassingen.",
		createError: "Sleutel maken mislukt.",
		newKey: "Nieuwe sleutel",
		oneTime: "Slechts eenmaal zichtbaar. Bewaar hem veilig.",
		copyKey: "Sleutel kopiëren",
		hide: "Opgeslagen",
		api: "API gebruiken",
		apiDescription: "Verstuur een pdf en ontvanger via de API.",
		copyExample: "Voorbeeld kopiëren",
		example: "Voorbeeld tonen",
		limits: (mb: number, pages: number) => `Pdf: maximaal ${mb} MB en ${pages} pagina's.`,
		docs: "OpenAPI-documentatie",
		list: "Contracten",
		download: "Ondertekende pdf",
		copyKeyOk: "Sleutel gekopieerd.",
		copyExampleOk: "Voorbeeld gekopieerd.",
		copyFailed: "Kopieer handmatig.",
		revokeTitle: "Sleutel intrekken?",
		revokeDescription: (name: string) => `‘${name}’ verliest direct toegang.`,
		cancel: "Annuleren",
		revoke: "Intrekken",
		revoking: "Intrekken…",
		active: "Actief",
		revoked: "Ingetrokken",
		created: "Gemaakt",
		lastUsed: "Laatst gebruikt",
		revokeLabel: (name: string) => `${name} intrekken`,
	},
} as const;

const sendExample = `curl --fail-with-body https://sign.amerged.com/api/contracts \\
  -H "Authorization: Bearer $AMERGED_SIGN_TOKEN" \\
  -H "Idempotency-Key: $(uuidgen)" \\
  -F "pdf=@contract.pdf;type=application/pdf" \\
  -F "definition=@fields.json;type=application/json"`;

export function ApiAccess({ csrfToken }: ApiAccessProps) {
	const { language } = useLanguage();
	const t = copy[language];
	const queryClient = useQueryClient();
	const [copyStatus, setCopyStatus] = useState<"key" | "example" | "failed" | null>(null);
	const [pendingRevoke, setPendingRevoke] = useState<ApiToken | null>(null);
	const listing = useQuery({
		queryKey: consoleKeys.tokens,
		queryFn: async () =>
			z.object({ data: z.array(tokenSchema) }).parse(await consoleRequest("/api/auth/tokens")).data,
		retry: false,
	});
	const generation = useMutation({
		gcTime: 0,
		mutationFn: async (name: string) => {
			const body = await consoleRequest("/api/auth/tokens", {
				method: "POST",
				headers: mutationHeaders(csrfToken),
				body: JSON.stringify({ name }),
			});
			return z
				.object({
					data: z.object({
						secret: z.string(),
						token: z.object({
							id: z.string(),
							name: z.string(),
							hint: z.string(),
							createdAt: z.string(),
						}),
					}),
				})
				.parse(body).data;
		},
		onSuccess: () => {
			form.reset();
			return queryClient.invalidateQueries({ queryKey: consoleKeys.tokens });
		},
	});
	const revocation = useMutation({
		mutationFn: (token: ApiToken) =>
			consoleRequest(`/api/auth/tokens/${encodeURIComponent(token.id)}`, {
				method: "DELETE",
				headers: mutationHeaders(csrfToken),
			}),
		onSuccess: () => {
			setPendingRevoke(null);
			return queryClient.invalidateQueries({ queryKey: consoleKeys.tokens });
		},
	});
	const form = useForm({
		defaultValues: { name: "" },
		onSubmit: ({ value }) => {
			setCopyStatus(null);
			generation.mutate(value.name.trim());
		},
	});
	async function copyToClipboard(value: string, kind: "key" | "example"): Promise<void> {
		try {
			await navigator.clipboard.writeText(value);
			setCopyStatus(kind);
		} catch {
			setCopyStatus("failed");
		}
	}

	return (
		<div className="space-y-6">
			<Panel className="space-y-5">
				<div className="space-y-1">
					<PanelTitle>{t.title}</PanelTitle>
				</div>
				{listing.isPending ? (
					<LoadingText>{t.loading}</LoadingText>
				) : listing.isError ? (
					<Alert variant="destructive">
						<AlertTitle>{t.loadError}</AlertTitle>
						<AlertDescription>{consoleErrorMessage(listing.error, language)}</AlertDescription>
					</Alert>
				) : listing.data.length ? (
					<ul className="divide-y">
						{listing.data.map((token) => (
							<TokenRow
								key={token.id}
								token={token}
								onRevoke={setPendingRevoke}
								language={language}
							/>
						))}
					</ul>
				) : (
					<EmptyState icon={KeyRound} title={t.empty} />
				)}
				<fieldset
					disabled={
						generation.isPending || Boolean(generation.data) || listing.isPending || listing.isError
					}
				>
					<form
						className="flex flex-col items-start gap-3 border-t pt-5 sm:flex-row sm:items-end"
						onSubmit={(event) => {
							event.preventDefault();
							void form.handleSubmit();
						}}
					>
						<form.Field
							name="name"
							validators={{
								onSubmit: ({ value }) => (value.trim() ? undefined : t.required),
							}}
						>
							{(field) => (
								<div className="w-full flex-1 space-y-2">
									<Label htmlFor="api-key-name">{t.name}</Label>
									<Input
										id="api-key-name"
										name={field.name}
										required
										maxLength={80}
										value={field.state.value}
										onBlur={field.handleBlur}
										onChange={(event) => field.handleChange(event.target.value)}
										aria-invalid={field.state.meta.errors.length > 0}
									/>
									{field.state.meta.errors.length ? (
										<p className="text-destructive text-sm">{field.state.meta.errors.join(" ")}</p>
									) : null}
								</div>
							)}
						</form.Field>
						<Button type="submit">
							<Plus aria-hidden="true" />
							{generation.isPending ? t.creating : t.create}
						</Button>
					</form>
				</fieldset>
				<p className="text-muted-foreground text-xs leading-5">{t.security}</p>
				{generation.isError ? (
					<Alert variant="destructive">
						<AlertTitle>{t.createError}</AlertTitle>
						<AlertDescription>{consoleErrorMessage(generation.error, language)}</AlertDescription>
					</Alert>
				) : null}
			</Panel>
			{generation.data ? (
				<Alert role="status">
					<AlertTitle>{t.newKey}</AlertTitle>
					<AlertDescription className="space-y-3">
						<p>{t.oneTime}</p>
						<code className="block select-all break-all rounded-md bg-muted p-3 text-sm">
							{generation.data.secret}
						</code>
						<div className="flex flex-wrap gap-2">
							<Button
								variant="outline"
								onClick={() => copyToClipboard(generation.data.secret, "key")}
							>
								<Copy aria-hidden="true" />
								{t.copyKey}
							</Button>
							<Button
								variant="ghost"
								onClick={() => {
									generation.reset();
									setCopyStatus(null);
								}}
							>
								<Check aria-hidden="true" />
								{t.hide}
							</Button>
						</div>
					</AlertDescription>
				</Alert>
			) : null}
			<Panel className="space-y-5">
				<div className="flex flex-wrap items-start justify-between gap-3">
					<div className="space-y-1">
						<PanelTitle>{t.api}</PanelTitle>
						<PanelDescription>{t.apiDescription}</PanelDescription>
					</div>
					<Button asChild variant="outline" size="sm">
						<a href="/openapi.json" target="_blank" rel="noreferrer">
							{t.docs} ↗
						</a>
					</Button>
				</div>
				<p className="text-muted-foreground text-sm leading-6">
					{t.limits(MAX_SOURCE_PDF_BYTES / 1024 / 1024, MAX_SOURCE_PDF_PAGES)}
				</p>
				<details className="space-y-3">
					<summary className="cursor-pointer text-sm underline underline-offset-4">
						{t.example}
					</summary>
					<pre className="overflow-x-auto border bg-muted/40 p-4 text-xs leading-6">
						<code>{sendExample}</code>
					</pre>
					<Button
						variant="outline"
						size="sm"
						onClick={() => copyToClipboard(sendExample, "example")}
					>
						<Copy aria-hidden="true" />
						{t.copyExample}
					</Button>
				</details>
				<div className="grid gap-4 text-sm sm:grid-cols-2">
					<div className="space-y-1">
						<p className="font-medium">{t.list}</p>
						<code className="break-all text-muted-foreground text-xs">GET /api/contracts</code>
					</div>
					<div className="space-y-1">
						<p className="font-medium">{t.download}</p>
						<code className="break-all text-muted-foreground text-xs">
							GET /api/contracts/&#123;id&#125;/pdf
						</code>
					</div>
				</div>
			</Panel>
			{copyStatus ? (
				<output className="text-muted-foreground text-sm" aria-live="polite">
					{copyStatus === "key"
						? t.copyKeyOk
						: copyStatus === "example"
							? t.copyExampleOk
							: t.copyFailed}
				</output>
			) : null}
			<Dialog
				open={Boolean(pendingRevoke)}
				onOpenChange={(open) => {
					if (!open && !revocation.isPending) setPendingRevoke(null);
				}}
			>
				<DialogContent>
					<DialogHeader>
						<DialogTitle>{t.revokeTitle}</DialogTitle>
						<DialogDescription>{t.revokeDescription(pendingRevoke?.name ?? "")}</DialogDescription>
					</DialogHeader>
					{revocation.isError ? (
						<Alert variant="destructive">
							<AlertDescription>{consoleErrorMessage(revocation.error, language)}</AlertDescription>
						</Alert>
					) : null}
					<DialogFooter>
						<DialogClose asChild>
							<Button variant="outline" disabled={revocation.isPending}>
								{t.cancel}
							</Button>
						</DialogClose>
						<Button
							variant="destructive"
							disabled={revocation.isPending}
							onClick={() => {
								if (pendingRevoke) revocation.mutate(pendingRevoke);
							}}
						>
							{revocation.isPending ? t.revoking : t.revoke}
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>
		</div>
	);
}

interface TokenRowProps {
	token: ApiToken;
	onRevoke: (token: ApiToken) => void;
	language: ReturnType<typeof useLanguage>["language"];
}

function TokenRow({ token, onRevoke, language }: TokenRowProps) {
	const t = copy[language];
	const active = token.status === "active";
	return (
		<li className="flex flex-wrap items-center justify-between gap-3 py-4">
			<div className="min-w-0 space-y-1">
				<p className="flex flex-wrap items-center gap-2 font-medium text-sm">
					{token.name}
					<StatusBadge tone={active ? "success" : "neutral"}>
						{active ? t.active : t.revoked}
					</StatusBadge>
				</p>
				<p className="text-muted-foreground text-xs">
					<code>{token.hint}</code> · {t.created} {formatDate(token.createdAt, language)}
					{token.lastUsedAt ? ` · ${t.lastUsed} ${formatDate(token.lastUsedAt, language)}` : ""}
				</p>
			</div>
			{active ? (
				<Button
					variant="ghost"
					size="sm"
					aria-label={t.revokeLabel(token.name)}
					onClick={() => onRevoke(token)}
				>
					<Trash2 aria-hidden="true" />
					{t.revoke}
				</Button>
			) : null}
		</li>
	);
}
