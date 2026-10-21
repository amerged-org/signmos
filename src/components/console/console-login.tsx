import { useForm } from "@tanstack/react-form";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowRight, Check, Mail } from "lucide-react";
import { useEffect, useRef } from "react";
import { consoleRequest, sessionOptions } from "@/components/console/console-api";
import { ConsoleBrand, ConsoleFooter } from "@/components/console/console-brand";
import { PageHeader, PageShell } from "@/components/layout/page-shell";
import { LoadingText } from "@/components/patterns/loading-text";
import { Panel } from "@/components/patterns/panel";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export function ConsoleLogin() {
	const queryClient = useQueryClient();
	const session = useQuery(sessionOptions);
	const redeemed = useRef(false);
	const redeem = useMutation({
		gcTime: 0,
		mutationFn: (credential: string) =>
			consoleRequest("/api/auth/redeem-login", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ credential }),
			}),
		onSuccess: () => {
			queryClient.clear();
			window.location.replace("/");
		},
	});
	const request = useMutation({
		mutationFn: (email: string) =>
			consoleRequest("/api/auth/request-login", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ email }),
			}),
	});
	const form = useForm({
		defaultValues: { email: "" },
		onSubmit: ({ value }) => {
			request.mutate(value.email.trim());
		},
	});

	useEffect(() => {
		if (redeemed.current) return;
		const credential = new URLSearchParams(window.location.hash.slice(1)).get("credential");
		if (!credential) return;
		redeemed.current = true;
		window.history.replaceState(null, "", "/login");
		redeem.mutate(credential);
	}, [redeem.mutate]);

	useEffect(() => {
		if (session.data?.authenticated && !redeem.isPending) window.location.replace("/");
	}, [session.data?.authenticated, redeem.isPending]);

	return (
		<PageShell width="narrow" center>
			<ConsoleBrand />
			<PageHeader
				wordmark={false}
				title="Ein guter Anfang. Eine klare Unterschrift."
				lead="Melde dich an, um Verträge zu versenden und deine Unterschriften im Blick zu behalten."
			/>
			{redeem.isPending || session.data?.authenticated ? (
				<LoadingText boxed>Sichere Anmeldung wird abgeschlossen…</LoadingText>
			) : request.isSuccess ? (
				<Panel className="space-y-4" role="status">
					<span className="inline-flex size-11 items-center justify-center rounded-full bg-muted">
						<Mail aria-hidden="true" className="size-5" />
					</span>
					<h2 className="font-semibold text-lg">Schau in dein Postfach.</h2>
					<p className="text-muted-foreground text-sm leading-6">
						Wenn deine E-Mail-Adresse freigeschaltet ist, erhältst du einen persönlichen
						Anmeldelink. Öffne ihn, um fortzufahren.
					</p>
					<Button variant="outline" onClick={() => request.reset()}>
						Andere Adresse verwenden
					</Button>
				</Panel>
			) : (
				<Panel
					as="form"
					className="space-y-5"
					onSubmit={(event) => {
						event.preventDefault();
						void form.handleSubmit();
					}}
				>
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
								<Label htmlFor="login-email">Geschäftliche E-Mail-Adresse</Label>
								<Input
									id="login-email"
									name={field.name}
									type="email"
									autoComplete="email"
									required
									value={field.state.value}
									onBlur={field.handleBlur}
									onChange={(event) => field.handleChange(event.target.value)}
									aria-invalid={field.state.meta.errors.length > 0}
									aria-describedby={
										field.state.meta.errors.length ? "login-email-error" : undefined
									}
								/>
								{field.state.meta.errors.length ? (
									<p id="login-email-error" className="text-destructive text-sm">
										{field.state.meta.errors.join(" ")}
									</p>
								) : null}
							</div>
						)}
					</form.Field>
					<Button type="submit" className="w-full" size="lg" disabled={request.isPending}>
						{request.isPending ? "Link wird gesendet…" : "Anmeldelink erhalten"}
						<ArrowRight aria-hidden="true" />
					</Button>
					<p className="flex items-start gap-2 text-muted-foreground text-xs leading-5">
						<Check aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
						Du meldest dich über einen einmaligen Link an. Ein Passwort brauchst du dafür nicht.
					</p>
				</Panel>
			)}
			{redeem.isError || request.isError ? (
				<Alert variant="destructive">
					<AlertTitle>Anmeldung nicht möglich</AlertTitle>
					<AlertDescription>{redeem.error?.message ?? request.error?.message}</AlertDescription>
				</Alert>
			) : null}
			<ConsoleFooter />
		</PageShell>
	);
}
