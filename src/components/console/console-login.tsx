import { useForm } from "@tanstack/react-form";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowRight, Check, Mail } from "lucide-react";
import { useEffect, useRef } from "react";
import { consoleRequest, sessionOptions } from "@/components/console/console-api";
import { ConsoleBrand, ConsoleFooter } from "@/components/console/console-brand";
import { PageShell } from "@/components/layout/page-shell";
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
		<PageShell width="wide" className="sm:py-8">
			<header className="flex items-center justify-between gap-6 border-b border-foreground pb-6">
				<ConsoleBrand />
				<span className="hidden font-mono text-[10px] uppercase tracking-[0.12em] text-muted-foreground sm:block">
					Digital unterschreiben / Sicherer Zugang
				</span>
			</header>
			<div className="grid gap-6 py-2 sm:gap-10 sm:py-8 lg:grid-cols-[minmax(0,1.1fr)_minmax(320px,0.75fr)] lg:gap-20 lg:py-16">
				<section className="max-w-xl space-y-5 sm:space-y-7" aria-labelledby="login-heading">
					<p className="flex items-center gap-3 font-mono text-[10px] uppercase tracking-[0.14em] text-muted-foreground">
						<span aria-hidden="true" className="size-1.5 bg-destructive" />
						amerged Sign / Anmeldung
					</p>
					<h1
						id="login-heading"
						className="text-balance font-serif text-4xl font-normal leading-[1.05] tracking-[-0.04em] sm:text-6xl"
					>
						Ein guter Anfang.
						<br />
						<em>Eine klare Unterschrift</em>
						<span className="text-destructive">.</span>
					</h1>
					<p className="max-w-md text-pretty font-serif text-base leading-7 text-muted-foreground sm:text-lg sm:leading-8">
						Verträge versenden, unterschreiben und im Blick behalten. Ein sicherer Link bringt dich
						direkt zu deinem Arbeitsbereich.
					</p>
					<div className="hidden max-w-md border-t pt-5 font-mono text-[10px] uppercase tracking-[0.08em] text-muted-foreground lg:flex lg:justify-between lg:gap-4">
						<span>
							<span className="text-destructive">01 /</span> Vertrag senden
						</span>
						<span>
							<span className="text-destructive">02 /</span> Unterschreiben
						</span>
						<span>
							<span className="text-destructive">03 /</span> Fertig
						</span>
					</div>
				</section>
				<div className="space-y-5 lg:pt-1">
					{redeem.isPending || session.data?.authenticated ? (
						<LoadingText boxed>Sichere Anmeldung wird abgeschlossen…</LoadingText>
					) : request.isSuccess ? (
						<Panel
							className="space-y-5 rounded-none border-t-2 border-t-foreground p-6 shadow-none sm:p-8"
							role="status"
						>
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
							className="space-y-6 rounded-none border-t-2 border-t-foreground p-6 shadow-none sm:p-8"
							onSubmit={(event) => {
								event.preventDefault();
								void form.handleSubmit();
							}}
						>
							<div className="space-y-2">
								<p className="font-mono text-[10px] uppercase tracking-[0.1em] text-destructive">
									01 / Sicher anmelden
								</p>
								<h2 className="font-serif text-3xl font-normal tracking-tight">
									Willkommen zurück.
								</h2>
								<p className="font-serif text-sm leading-6 text-muted-foreground">
									Wir senden dir einen persönlichen Link für die Anmeldung.
								</p>
							</div>
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
				</div>
			</div>
			<ConsoleFooter />
		</PageShell>
	);
}
