import { useForm } from "@tanstack/react-form";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowRight, Mail } from "lucide-react";
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
import { useLanguage } from "@/lib/i18n";

const copy = {
	de: {
		title: "Verträge. Einfach unterschrieben.",
		label: "Anmelden",
		intro: "Wir senden dir einen Anmeldelink.",
		email: "E-Mail-Adresse",
		invalid: "Bitte E-Mail prüfen.",
		sending: "Wird gesendet…",
		send: "Link senden",
		checking: "Anmeldung läuft…",
		checkInbox: "Prüfe dein Postfach.",
		sent: "Wenn die Adresse freigeschaltet ist, erhältst du einen Link.",
		another: "Andere E-Mail",
		error: "Anmeldung fehlgeschlagen",
		errorDetail: "Bitte erneut versuchen.",
	},
	en: {
		title: "Contracts. Simply signed.",
		label: "Sign in",
		intro: "We’ll email you a sign-in link.",
		email: "Email address",
		invalid: "Check your email.",
		sending: "Sending…",
		send: "Send link",
		checking: "Signing in…",
		checkInbox: "Check your inbox.",
		sent: "If your address is authorized, you’ll receive a link.",
		another: "Use another email",
		error: "Sign-in failed",
		errorDetail: "Please try again.",
	},
	nl: {
		title: "Contracten. Eenvoudig getekend.",
		label: "Inloggen",
		intro: "Je ontvangt een inloglink per e-mail.",
		email: "E-mailadres",
		invalid: "Controleer je e-mailadres.",
		sending: "Verzenden…",
		send: "Link versturen",
		checking: "Bezig met inloggen…",
		checkInbox: "Controleer je inbox.",
		sent: "Als je adres toegang heeft, ontvang je een link.",
		another: "Ander e-mailadres",
		error: "Inloggen mislukt",
		errorDetail: "Probeer het opnieuw.",
	},
} as const;

export function ConsoleLogin() {
	const { language } = useLanguage();
	const t = copy[language];
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
		window.history.replaceState(null, "", `/login${window.location.search}`);
		redeem.mutate(credential);
	}, [redeem.mutate]);

	useEffect(() => {
		if (session.data?.authenticated && !redeem.isPending) window.location.replace("/");
	}, [session.data?.authenticated, redeem.isPending]);

	return (
		<PageShell width="wide" className="sm:py-8">
			<header className="flex items-center justify-between gap-6 border-b border-foreground pb-6">
				<ConsoleBrand />
			</header>
			<div className="grid gap-6 py-2 sm:gap-10 sm:py-8 lg:grid-cols-[minmax(0,1.1fr)_minmax(320px,0.75fr)] lg:gap-20 lg:py-16">
				<section className="max-w-xl space-y-5 sm:space-y-7" aria-labelledby="login-heading">
					<p className="flex items-center gap-3 font-mono text-[10px] uppercase tracking-[0.14em] text-muted-foreground">
						<span aria-hidden="true" className="size-1.5 bg-destructive" />
						amerged Sign
					</p>
					<h1
						id="login-heading"
						className="text-balance font-serif text-4xl font-normal leading-[1.05] tracking-[-0.04em] sm:text-6xl"
					>
						{t.title}
					</h1>
				</section>
				<div className="space-y-5 lg:pt-1">
					{redeem.isPending || session.data?.authenticated ? (
						<LoadingText boxed>{t.checking}</LoadingText>
					) : request.isSuccess ? (
						<Panel
							className="space-y-5 rounded-none border-t-2 border-t-foreground p-6 shadow-none sm:p-8"
							role="status"
						>
							<span className="inline-flex size-11 items-center justify-center rounded-full bg-muted">
								<Mail aria-hidden="true" className="size-5" />
							</span>
							<h2 className="font-semibold text-lg">{t.checkInbox}</h2>
							<p className="text-muted-foreground text-sm leading-6">{t.sent}</p>
							<Button variant="outline" onClick={() => request.reset()}>
								{t.another}
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
								<h2 className="font-serif text-3xl font-normal tracking-tight">{t.label}</h2>
								<p className="font-serif text-sm leading-6 text-muted-foreground">{t.intro}</p>
							</div>
							<form.Field
								name="email"
								validators={{
									onSubmit: ({ value }) =>
										/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim()) ? undefined : t.invalid,
								}}
							>
								{(field) => (
									<div className="space-y-2">
										<Label htmlFor="login-email">{t.email}</Label>
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
								{request.isPending ? t.sending : t.send}
								<ArrowRight aria-hidden="true" />
							</Button>
						</Panel>
					)}
					{redeem.isError || request.isError ? (
						<Alert variant="destructive">
							<AlertTitle>{t.error}</AlertTitle>
							<AlertDescription>{t.errorDetail}</AlertDescription>
						</Alert>
					) : null}
				</div>
			</div>
			<ConsoleFooter />
		</PageShell>
	);
}
