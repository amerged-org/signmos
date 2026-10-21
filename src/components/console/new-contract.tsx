import { useForm } from "@tanstack/react-form";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Check, FileText, Send, Upload } from "lucide-react";
import { useRef, useState } from "react";
import { z } from "zod";
import {
	type Contract,
	consoleKeys,
	consoleRequest,
	contractSchema,
	mutationHeaders,
} from "@/components/console/console-api";
import { Panel, PanelDescription, PanelTitle } from "@/components/patterns/panel";
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

interface NewContractProps {
	csrfToken: string;
	onSent: (contract: Contract) => void;
	onCancel: () => void;
}

interface ContractValues {
	title: string;
	name: string;
	email: string;
	file: File | null;
}

const maxPdfMegabytes = MAX_SOURCE_PDF_BYTES / 1024 / 1024;
const maxContractPages = MAX_SOURCE_PDF_PAGES - 1;

export function NewContract({ csrfToken, onSent, onCancel }: NewContractProps) {
	const queryClient = useQueryClient();
	const [confirmOpen, setConfirmOpen] = useState(false);
	const submittedRequest = useRef<{ payload: string; key: string } | null>(null);
	const fileInput = useRef<HTMLInputElement>(null);
	const send = useMutation({
		gcTime: 0,
		mutationFn: async (value: ContractValues) => {
			if (!value.file) throw new Error("Bitte wähle einen PDF-Vertrag aus.");
			const base64 = await encodePdf(value.file);
			const payload = JSON.stringify({
				title: value.title.trim(),
				recipient: { name: value.name.trim(), email: value.email.trim() },
				pdf: { filename: value.file.name, base64 },
			});
			if (submittedRequest.current?.payload !== payload) {
				submittedRequest.current = { payload, key: crypto.randomUUID() };
			}
			const body = await consoleRequest("/api/contracts", {
				method: "POST",
				headers: { ...mutationHeaders(csrfToken), "Idempotency-Key": submittedRequest.current.key },
				body: payload,
			});
			return z.object({ data: contractSchema }).parse(body).data;
		},
		onSuccess: async (contract) => {
			await queryClient.invalidateQueries({ queryKey: consoleKeys.contracts });
			onSent(contract);
		},
	});
	const form = useForm({
		defaultValues: { title: "", name: "", email: "", file: null } as ContractValues,
		onSubmit: () => {
			setConfirmOpen(true);
		},
	});

	return (
		<>
			<Panel
				as="form"
				className="space-y-7"
				onSubmit={(event) => {
					event.preventDefault();
					void form.handleSubmit();
				}}
			>
				<div className="flex flex-wrap items-start justify-between gap-3">
					<div className="space-y-1">
						<PanelTitle>Neuen Vertrag versenden</PanelTitle>
						<PanelDescription>
							PDF auswählen. Empfänger eintragen. Unterschrift anfragen.
						</PanelDescription>
					</div>
					<Button type="button" variant="ghost" onClick={onCancel}>
						Abbrechen
					</Button>
				</div>
				<form.Field
					name="file"
					validators={{
						onSubmit: ({ value }) =>
							!value
								? "Bitte wähle eine PDF-Datei aus."
								: value.size > MAX_SOURCE_PDF_BYTES
									? `Die PDF-Datei darf höchstens ${maxPdfMegabytes} MB groß sein.`
									: !value.name.toLowerCase().endsWith(".pdf")
										? "Bitte wähle eine PDF-Datei aus."
										: undefined,
					}}
				>
					{(field) => (
						<div className="space-y-2">
							<Label htmlFor="contract-pdf">Vertrag als PDF</Label>
							<div className="relative flex flex-col items-center gap-3 rounded-xl border border-dashed bg-muted/30 px-5 py-8 text-center transition-colors focus-within:border-ring focus-within:ring-2 focus-within:ring-ring/30 hover:bg-muted/60">
								{field.state.value ? (
									<FileText aria-hidden="true" className="size-7 text-primary" />
								) : (
									<Upload aria-hidden="true" className="size-7 text-muted-foreground" />
								)}
								<div>
									<p className="break-all font-medium text-sm">
										{field.state.value?.name ?? "PDF auswählen oder hierher ziehen"}
									</p>
									<p className="mt-1 text-muted-foreground text-xs">
										{field.state.value
											? `${(field.state.value.size / 1024 / 1024).toLocaleString("de-DE", { maximumFractionDigits: 1 })} MB · Zum Ändern klicken`
											: `Eine PDF-Datei, maximal ${maxPdfMegabytes} MB und ${maxContractPages} Seiten`}
									</p>
								</div>
								<input
									ref={fileInput}
									className="absolute inset-0 size-full cursor-pointer opacity-0"
									id="contract-pdf"
									type="file"
									name={field.name}
									accept="application/pdf,.pdf"
									aria-invalid={field.state.meta.errors.length > 0}
									aria-describedby="contract-pdf-hint"
									onBlur={field.handleBlur}
									onChange={(event) => {
										const file = event.target.files?.[0] ?? null;
										field.handleChange(file);
										if (file && !form.state.values.title)
											form.setFieldValue("title", file.name.replace(/\.pdf$/i, ""));
									}}
								/>
							</div>
							<p
								id="contract-pdf-hint"
								className={
									field.state.meta.errors.length
										? "text-destructive text-sm"
										: "text-muted-foreground text-xs"
								}
							>
								{field.state.meta.errors.join(" ") ||
									"Für Unterschrift und Datum wird eine eigene Seite am Ende des Vertrags ergänzt."}
							</p>
						</div>
					)}
				</form.Field>
				<form.Field
					name="title"
					validators={{
						onSubmit: ({ value }) =>
							value.trim() ? undefined : "Bitte gib dem Vertrag einen Titel.",
					}}
				>
					{(field) => (
						<div className="space-y-2">
							<Label htmlFor="contract-title">Vertragstitel</Label>
							<Input
								id="contract-title"
								name={field.name}
								required
								maxLength={200}
								value={field.state.value}
								onBlur={field.handleBlur}
								onChange={(event) => field.handleChange(event.target.value)}
								aria-invalid={field.state.meta.errors.length > 0}
								aria-describedby={
									field.state.meta.errors.length ? "contract-title-error" : undefined
								}
							/>
							{field.state.meta.errors.length ? (
								<p id="contract-title-error" className="text-destructive text-sm">
									{field.state.meta.errors.join(" ")}
								</p>
							) : null}
						</div>
					)}
				</form.Field>
				<fieldset className="space-y-4 border-t pt-5">
					<legend className="px-1 font-medium text-sm">Wer soll unterschreiben?</legend>
					<div className="grid gap-4 sm:grid-cols-2">
						<form.Field
							name="name"
							validators={{
								onSubmit: ({ value }) =>
									value.trim() ? undefined : "Bitte gib den vollständigen Namen ein.",
							}}
						>
							{(field) => (
								<div className="space-y-2">
									<Label htmlFor="recipient-name">Vollständiger Name</Label>
									<Input
										id="recipient-name"
										name={field.name}
										autoComplete="off"
										required
										maxLength={200}
										value={field.state.value}
										onBlur={field.handleBlur}
										onChange={(event) => field.handleChange(event.target.value)}
										aria-invalid={field.state.meta.errors.length > 0}
										aria-describedby={
											field.state.meta.errors.length ? "recipient-name-error" : undefined
										}
									/>
									{field.state.meta.errors.length ? (
										<p id="recipient-name-error" className="text-destructive text-sm">
											{field.state.meta.errors.join(" ")}
										</p>
									) : null}
								</div>
							)}
						</form.Field>
						<form.Field
							name="email"
							validators={{
								onSubmit: ({ value }) =>
									/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim())
										? undefined
										: "Bitte gib eine gültige E-Mail-Adresse ein.",
							}}
						>
							{(field) => (
								<div className="space-y-2">
									<Label htmlFor="recipient-email">E-Mail-Adresse</Label>
									<Input
										id="recipient-email"
										name={field.name}
										type="email"
										autoComplete="off"
										required
										value={field.state.value}
										onBlur={field.handleBlur}
										onChange={(event) => field.handleChange(event.target.value)}
										aria-invalid={field.state.meta.errors.length > 0}
										aria-describedby={
											field.state.meta.errors.length ? "recipient-email-error" : undefined
										}
									/>
									{field.state.meta.errors.length ? (
										<p id="recipient-email-error" className="text-destructive text-sm">
											{field.state.meta.errors.join(" ")}
										</p>
									) : null}
								</div>
							)}
						</form.Field>
					</div>
				</fieldset>
				<div className="flex flex-wrap items-center justify-between gap-4 border-t pt-5">
					<p className="flex items-center gap-2 text-muted-foreground text-xs">
						<Check aria-hidden="true" className="size-4" />
						Persönlicher Link zur Unterschrift per E-Mail.
					</p>
					<Button type="submit" size="lg" disabled={send.isPending}>
						Versand prüfen
						<Send aria-hidden="true" />
					</Button>
				</div>
			</Panel>
			<Dialog
				open={confirmOpen}
				onOpenChange={(open) => {
					if (!send.isPending) setConfirmOpen(open);
				}}
			>
				<DialogContent showCloseButton={!send.isPending}>
					<DialogHeader>
						<DialogTitle>Vertrag zur Unterschrift senden?</DialogTitle>
						<DialogDescription>
							Bitte prüfe den Empfänger. Die Einladung wird direkt per E-Mail verschickt.
						</DialogDescription>
					</DialogHeader>
					<form.Subscribe selector={(state) => state.values}>
						{(value) => (
							<dl className="space-y-3 rounded-lg bg-muted/50 p-4 text-sm">
								<div>
									<dt className="text-muted-foreground text-xs">Vertrag</dt>
									<dd className="mt-1 break-words font-medium">{value.title}</dd>
								</div>
								<div>
									<dt className="text-muted-foreground text-xs">Empfänger</dt>
									<dd className="mt-1 break-words">
										{value.name}
										<br />
										{value.email}
									</dd>
								</div>
							</dl>
						)}
					</form.Subscribe>
					{send.isError ? (
						<Alert variant="destructive">
							<AlertTitle>Versand nicht abgeschlossen</AlertTitle>
							<AlertDescription>{send.error.message}</AlertDescription>
						</Alert>
					) : null}
					<DialogFooter>
						<DialogClose asChild>
							<Button variant="outline" disabled={send.isPending}>
								Zurück
							</Button>
						</DialogClose>
						<Button disabled={send.isPending} onClick={() => send.mutate(form.state.values)}>
							{send.isPending ? "Vertrag wird versendet…" : "Jetzt versenden"}
							<Send aria-hidden="true" />
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>
		</>
	);
}

function encodePdf(file: File): Promise<string> {
	return new Promise((resolve, reject) => {
		const reader = new FileReader();
		reader.onload = () => {
			if (typeof reader.result !== "string") {
				reject(new Error("Die PDF-Datei konnte nicht gelesen werden."));
				return;
			}
			const separator = reader.result.indexOf(",");
			if (separator < 0) {
				reject(new Error("Die PDF-Datei konnte nicht gelesen werden."));
				return;
			}
			resolve(reader.result.slice(separator + 1));
		};
		reader.onerror = () => reject(new Error("Die PDF-Datei konnte nicht gelesen werden."));
		reader.readAsDataURL(file);
	});
}
