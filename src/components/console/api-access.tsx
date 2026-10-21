import { useForm } from "@tanstack/react-form";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Copy, KeyRound, Plus, Trash2 } from "lucide-react";
import { useState } from "react";
import { z } from "zod";
import {
	type ApiToken,
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

interface ApiAccessProps {
	csrfToken: string;
}

const sendExample = `export AMERGED_SIGN_TOKEN="DEIN_API_SCHLÜSSEL"
PDF_BASE64="$(base64 < vertrag.pdf | tr -d '\\n')"

jq -n --arg pdf "$PDF_BASE64" '{
  title: "Beratungsvertrag",
  recipient: {
    name: "Erika Musterfrau",
    email: "erika@example.com"
  },
  pdf: { filename: "vertrag.pdf", base64: $pdf }
}' | curl --fail-with-body https://sign.amerged.com/api/contracts \\
  -H "Authorization: Bearer $AMERGED_SIGN_TOKEN" \\
  -H "Content-Type: application/json" \\
  -H "Idempotency-Key: $(uuidgen)" \\
  --data-binary @-`;

export function ApiAccess({ csrfToken }: ApiAccessProps) {
	const queryClient = useQueryClient();
	const [copyStatus, setCopyStatus] = useState("");
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
			setCopyStatus("");
			generation.mutate(value.name.trim());
		},
	});
	async function copy(value: string, label: string): Promise<void> {
		try {
			await navigator.clipboard.writeText(value);
			setCopyStatus(label);
		} catch {
			setCopyStatus("Bitte markiere den Text und kopiere ihn manuell.");
		}
	}

	return (
		<div className="space-y-6">
			<Panel className="space-y-5">
				<div className="space-y-1">
					<PanelTitle>API-Schlüssel</PanelTitle>
					<PanelDescription>Verbinde deine eigenen Anwendungen mit amerged Sign.</PanelDescription>
				</div>
				{listing.isPending ? (
					<LoadingText>API-Schlüssel werden geladen…</LoadingText>
				) : listing.isError ? (
					<Alert variant="destructive">
						<AlertTitle>Schlüssel konnten nicht geladen werden</AlertTitle>
						<AlertDescription>{listing.error.message}</AlertDescription>
					</Alert>
				) : listing.data.length ? (
					<ul className="divide-y">
						{listing.data.map((token) => (
							<TokenRow key={token.id} token={token} onRevoke={setPendingRevoke} />
						))}
					</ul>
				) : (
					<EmptyState
						icon={KeyRound}
						title="Deine erste Verbindung beginnt hier."
						description="Erstelle einen Schlüssel, um Verträge aus einer anderen Anwendung zu versenden."
					/>
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
								onSubmit: ({ value }) =>
									value.trim() ? undefined : "Bitte gib dem Schlüssel einen Namen.",
							}}
						>
							{(field) => (
								<div className="w-full flex-1 space-y-2">
									<Label htmlFor="api-key-name">Name der Verbindung</Label>
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
							{generation.isPending ? "Wird erstellt…" : "Schlüssel erstellen"}
						</Button>
					</form>
				</fieldset>
				<p className="text-muted-foreground text-xs leading-5">
					Ein Schlüssel hat Zugriff auf deine Verträge. Hinterlege ihn nur in Anwendungen, denen du
					vertraust.
				</p>
				{generation.isError ? (
					<Alert variant="destructive">
						<AlertTitle>Schlüssel konnte nicht erstellt werden</AlertTitle>
						<AlertDescription>{generation.error.message}</AlertDescription>
					</Alert>
				) : null}
			</Panel>
			{generation.data ? (
				<Alert role="status">
					<AlertTitle>Dein neuer Schlüssel · jetzt kopieren</AlertTitle>
					<AlertDescription className="space-y-3">
						<p>Er wird nur dieses eine Mal angezeigt. Speichere ihn an einem sicheren Ort.</p>
						<code className="block select-all break-all rounded-md bg-muted p-3 text-sm">
							{generation.data.secret}
						</code>
						<div className="flex flex-wrap gap-2">
							<Button
								variant="outline"
								onClick={() => copy(generation.data.secret, "Schlüssel kopiert.")}
							>
								<Copy aria-hidden="true" />
								Schlüssel kopieren
							</Button>
							<Button
								variant="ghost"
								onClick={() => {
									generation.reset();
									setCopyStatus("");
								}}
							>
								<Check aria-hidden="true" />
								Gespeichert und ausblenden
							</Button>
						</div>
					</AlertDescription>
				</Alert>
			) : null}
			<Panel className="space-y-5">
				<div className="flex flex-wrap items-start justify-between gap-3">
					<div className="space-y-1">
						<PanelTitle>Vertrag per API versenden</PanelTitle>
						<PanelDescription>
							Ein Aufruf erstellt den Vertrag und versendet die Einladung.
						</PanelDescription>
					</div>
					<Button
						variant="outline"
						size="sm"
						onClick={() => copy(sendExample, "API-Beispiel kopiert.")}
					>
						<Copy aria-hidden="true" />
						Beispiel kopieren
					</Button>
				</div>
				<p className="text-muted-foreground text-sm leading-6">
					Ersetze den Schlüssel, die PDF-Datei und die Empfängerdaten im Beispiel. Die PDF darf
					maximal {MAX_SOURCE_PDF_BYTES / 1024 / 1024} MB und {MAX_SOURCE_PDF_PAGES - 1} Seiten
					haben. Eine Unterschriftsseite wird automatisch ergänzt. Derselbe Idempotency-Key kann für
					eine unveränderte Wiederholung verwendet werden.
				</p>
				<pre className="overflow-x-auto rounded-lg border bg-muted/40 p-4 text-xs leading-6">
					<code>{sendExample}</code>
				</pre>
				<div className="grid gap-4 text-sm sm:grid-cols-2">
					<div className="space-y-1">
						<p className="font-medium">Verträge abrufen</p>
						<code className="break-all text-muted-foreground text-xs">GET /api/contracts</code>
						<p className="text-muted-foreground text-xs">
							Status, Empfänger und Datum deiner Verträge.
						</p>
					</div>
					<div className="space-y-1">
						<p className="font-medium">Unterzeichnete PDF laden</p>
						<code className="break-all text-muted-foreground text-xs">
							GET /api/contracts/&#123;id&#125;/pdf
						</code>
						<p className="text-muted-foreground text-xs">
							Verfügbar, sobald der Vertrag abgeschlossen ist.
						</p>
					</div>
				</div>
			</Panel>
			{copyStatus ? (
				<output className="text-muted-foreground text-sm" aria-live="polite">
					{copyStatus}
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
						<DialogTitle>API-Schlüssel widerrufen?</DialogTitle>
						<DialogDescription>
							Die Verbindung „{pendingRevoke?.name}“ verliert sofort den Zugriff. Du kannst
							anschließend einen neuen Schlüssel erstellen.
						</DialogDescription>
					</DialogHeader>
					{revocation.isError ? (
						<Alert variant="destructive">
							<AlertDescription>{revocation.error.message}</AlertDescription>
						</Alert>
					) : null}
					<DialogFooter>
						<DialogClose asChild>
							<Button variant="outline" disabled={revocation.isPending}>
								Abbrechen
							</Button>
						</DialogClose>
						<Button
							variant="destructive"
							disabled={revocation.isPending}
							onClick={() => {
								if (pendingRevoke) revocation.mutate(pendingRevoke);
							}}
						>
							{revocation.isPending ? "Wird widerrufen…" : "Schlüssel widerrufen"}
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
}

function TokenRow({ token, onRevoke }: TokenRowProps) {
	const active = token.status === "active";
	return (
		<li className="flex flex-wrap items-center justify-between gap-3 py-4">
			<div className="min-w-0 space-y-1">
				<p className="flex flex-wrap items-center gap-2 font-medium text-sm">
					{token.name}
					<StatusBadge tone={active ? "success" : "neutral"}>
						{active ? "Aktiv" : "Widerrufen"}
					</StatusBadge>
				</p>
				<p className="text-muted-foreground text-xs">
					<code>{token.hint}</code> · Erstellt am {formatDate(token.createdAt)}
					{token.lastUsedAt ? ` · Zuletzt genutzt am ${formatDate(token.lastUsedAt)}` : ""}
				</p>
			</div>
			{active ? (
				<Button
					variant="ghost"
					size="sm"
					aria-label={`${token.name} widerrufen`}
					onClick={() => onRevoke(token)}
				>
					<Trash2 aria-hidden="true" />
					Widerrufen
				</Button>
			) : null}
		</li>
	);
}
