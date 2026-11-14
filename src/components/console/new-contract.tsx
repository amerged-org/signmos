import { useForm } from "@tanstack/react-form";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { FileText, Send, Upload } from "lucide-react";
import { useRef, useState } from "react";
import { z } from "zod";
import {
	type Contract,
	consoleErrorMessage,
	consoleKeys,
	consoleRequest,
	contractSchema,
	mutationHeaders,
} from "@/components/console/console-api";
import { Panel, PanelTitle } from "@/components/patterns/panel";
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
import { consoleCopy } from "./console-copy";

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
	const { language } = useLanguage();
	const t = consoleCopy[language];
	const queryClient = useQueryClient();
	const [confirmOpen, setConfirmOpen] = useState(false);
	const submittedRequest = useRef<{ payload: string; key: string } | null>(null);
	const fileInput = useRef<HTMLInputElement>(null);
	const send = useMutation({
		gcTime: 0,
		mutationFn: async (value: ContractValues) => {
			if (!value.file) throw new Error(t.choosePdf);
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
				className="space-y-7 rounded-none border-t-2 border-t-foreground p-6 shadow-none sm:p-8"
				onSubmit={(event) => {
					event.preventDefault();
					void form.handleSubmit();
				}}
			>
				<div className="flex flex-wrap items-start justify-between gap-3">
					<div className="space-y-2">
						<PanelTitle className="font-serif text-2xl font-normal">{t.newContract}</PanelTitle>
					</div>
					<Button type="button" variant="ghost" onClick={onCancel}>
						{t.cancel}
					</Button>
				</div>
				<form.Field
					name="file"
					validators={{
						onSubmit: ({ value }) =>
							!value
								? t.choosePdf
								: value.size > MAX_SOURCE_PDF_BYTES
									? `${t.tooLarge} ${t.max} ${maxPdfMegabytes} MB.`
									: !value.name.toLowerCase().endsWith(".pdf")
										? t.choosePdf
										: undefined,
					}}
				>
					{(field) => (
						<div className="space-y-2">
							<Label htmlFor="contract-pdf">{t.pdf}</Label>
							<div className="relative flex flex-col items-center gap-3 border border-dashed bg-muted/30 px-5 py-8 text-center transition-colors focus-within:border-ring focus-within:ring-2 focus-within:ring-ring/30 hover:bg-muted/60">
								{field.state.value ? (
									<FileText aria-hidden="true" className="size-7 text-primary" />
								) : (
									<Upload aria-hidden="true" className="size-7 text-muted-foreground" />
								)}
								<div>
									<p className="break-all font-medium text-sm">
										{field.state.value?.name ?? t.selectPdf}
									</p>
									<p className="mt-1 text-muted-foreground text-xs">
										{field.state.value
											? `${(field.state.value.size / 1024 / 1024).toLocaleString({ de: "de-DE", en: "en-GB", nl: "nl-NL" }[language], { maximumFractionDigits: 1 })} MB · ${t.changeFile}`
											: `${t.max} ${maxPdfMegabytes} MB · ${maxContractPages} ${t.pages}`}
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
								{field.state.meta.errors.join(" ") || t.pdfHint}
							</p>
						</div>
					)}
				</form.Field>
				<form.Field
					name="title"
					validators={{
						onSubmit: ({ value }) => (value.trim() ? undefined : t.titleRequired),
					}}
				>
					{(field) => (
						<div className="space-y-2">
							<Label htmlFor="contract-title">{t.title}</Label>
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
					<legend className="px-1 font-medium text-sm">{t.signer}</legend>
					<div className="grid gap-4 sm:grid-cols-2">
						<form.Field
							name="name"
							validators={{
								onSubmit: ({ value }) => (value.trim() ? undefined : t.nameRequired),
							}}
						>
							{(field) => (
								<div className="space-y-2">
									<Label htmlFor="recipient-name">{t.fullName}</Label>
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
									/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim()) ? undefined : t.invalidEmail,
							}}
						>
							{(field) => (
								<div className="space-y-2">
									<Label htmlFor="recipient-email">{t.email}</Label>
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
					<Button type="submit" size="lg" disabled={send.isPending}>
						{t.review}
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
						<DialogTitle>{t.confirmTitle}</DialogTitle>
						<DialogDescription>{t.confirmDescription}</DialogDescription>
					</DialogHeader>
					<form.Subscribe selector={(state) => state.values}>
						{(value) => (
							<dl className="space-y-3 border bg-muted/50 p-4 text-sm">
								<div>
									<dt className="text-muted-foreground text-xs">{t.contract}</dt>
									<dd className="mt-1 break-words font-medium">{value.title}</dd>
								</div>
								<div>
									<dt className="text-muted-foreground text-xs">{t.recipient}</dt>
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
							<AlertTitle>{t.sendError}</AlertTitle>
							<AlertDescription>{consoleErrorMessage(send.error, language)}</AlertDescription>
						</Alert>
					) : null}
					<DialogFooter>
						<DialogClose asChild>
							<Button variant="outline" disabled={send.isPending}>
								{t.back}
							</Button>
						</DialogClose>
						<Button disabled={send.isPending} onClick={() => send.mutate(form.state.values)}>
							{send.isPending ? t.sending : t.sendNow}
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
