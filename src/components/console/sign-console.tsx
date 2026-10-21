import { type UseQueryResult, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
	Check,
	Code2,
	FileCheck2,
	FileClock,
	FileText,
	LogOut,
	Plus,
	RefreshCw,
} from "lucide-react";
import { type KeyboardEvent, useEffect, useState } from "react";
import { ApiAccess } from "@/components/console/api-access";
import {
	ConsoleRequestError,
	type ConsoleSession,
	type Contract,
	consoleRequest,
	contractsOptions,
	mutationHeaders,
	sessionOptions,
} from "@/components/console/console-api";
import { ConsoleBrand, ConsoleFooter } from "@/components/console/console-brand";
import { ContractList } from "@/components/console/contract-list";
import { NewContract } from "@/components/console/new-contract";
import { PageHeader, PageShell } from "@/components/layout/page-shell";
import { LoadingText } from "@/components/patterns/loading-text";
import { Panel } from "@/components/patterns/panel";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";

export function SignConsole() {
	const session = useQuery(sessionOptions);
	useEffect(() => {
		if (session.data && !session.data.authenticated) window.location.replace("/login");
	}, [session.data]);
	if (session.isPending || (session.data && !session.data.authenticated))
		return (
			<PageShell width="narrow" center>
				<ConsoleBrand />
				<LoadingText boxed>Anmeldung wird geprüft…</LoadingText>
			</PageShell>
		);
	if (
		session.isError ||
		!session.data?.authenticated ||
		!session.data.email ||
		!session.data.csrfToken
	)
		return (
			<PageShell width="narrow" center>
				<ConsoleBrand />
				<Alert variant="destructive">
					<AlertTitle>Anmeldung konnte nicht geprüft werden</AlertTitle>
					<AlertDescription>
						{session.error?.message ?? "Bitte melde dich erneut an."}
					</AlertDescription>
				</Alert>
				<Button asChild>
					<a href="/login">Zur Anmeldung</a>
				</Button>
			</PageShell>
		);
	return <AuthenticatedConsole session={session.data} csrfToken={session.data.csrfToken} />;
}

interface AuthenticatedConsoleProps {
	session: ConsoleSession;
	csrfToken: string;
}

function AuthenticatedConsole({ session, csrfToken }: AuthenticatedConsoleProps) {
	const queryClient = useQueryClient();
	const [tab, setTab] = useState<"contracts" | "api">("contracts");
	const [composing, setComposing] = useState(false);
	const [sentContract, setSentContract] = useState<Contract | null>(null);
	const contracts = useQuery(contractsOptions);
	const logout = useMutation({
		mutationFn: () =>
			consoleRequest("/api/auth/logout", { method: "POST", headers: mutationHeaders(csrfToken) }),
		onSuccess: () => {
			queryClient.clear();
			window.location.replace("/login");
		},
	});
	useEffect(() => {
		if (contracts.error instanceof ConsoleRequestError && contracts.error.status === 401)
			window.location.replace("/login");
	}, [contracts.error]);
	const total = contracts.data?.length;
	const completed = contracts.data?.filter((contract) => contract.status === "completed").length;
	const open = contracts.data?.filter(
		(contract) =>
			!["completed", "declined", "expired", "cancelled", "deleted"].includes(contract.status),
	).length;

	function startContract(): void {
		setComposing(true);
		setSentContract(null);
		setTab("contracts");
	}
	function changeTab(event: KeyboardEvent<HTMLButtonElement>): void {
		if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
		event.preventDefault();
		const target =
			event.key === "Home"
				? "contracts"
				: event.key === "End"
					? "api"
					: tab === "contracts"
						? "api"
						: "contracts";
		setTab(target);
		document.getElementById(`tab-${target}`)?.focus();
	}
	if (logout.isPending || logout.isError)
		return (
			<LogoutState pending={logout.isPending} error={logout.error} retry={() => logout.mutate()} />
		);

	return (
		<PageShell width="wide" className="sm:py-8">
			<header className="flex flex-wrap items-center justify-between gap-5 border-b pb-6">
				<ConsoleBrand />
				<div className="flex items-center gap-3">
					<span className="max-w-48 truncate text-muted-foreground text-xs sm:max-w-none">
						{session.email}
					</span>
					<Button
						variant="ghost"
						size="sm"
						aria-label="Abmelden"
						onClick={() => logout.mutate()}
						disabled={logout.isPending}
					>
						<LogOut aria-hidden="true" />
						<span className="hidden sm:inline">
							{logout.isPending ? "Wird abgemeldet…" : "Abmelden"}
						</span>
						<span className="sr-only sm:hidden">Abmelden</span>
					</Button>
				</div>
			</header>
			<div className="flex flex-wrap items-end justify-between gap-5">
				<PageHeader
					wordmark={false}
					title="Weniger Papierkram. Mehr Einigung."
					lead="Deine Verträge. Vom ersten Versand bis zur letzten Unterschrift."
				/>
				<Button size="lg" onClick={startContract}>
					<Plus aria-hidden="true" />
					Vertrag versenden
				</Button>
			</div>
			<div className="flex gap-1 border-b" role="tablist" aria-label="Arbeitsbereich">
				<button
					id="tab-contracts"
					type="button"
					role="tab"
					aria-selected={tab === "contracts"}
					aria-controls="panel-contracts"
					tabIndex={tab === "contracts" ? 0 : -1}
					onKeyDown={changeTab}
					className={`inline-flex items-center gap-2 border-b-2 px-4 py-3 text-sm transition-colors focus-visible:outline-2 focus-visible:outline-ring ${tab === "contracts" ? "border-primary font-medium text-primary" : "border-transparent text-muted-foreground hover:text-foreground"}`}
					onClick={() => setTab("contracts")}
				>
					<FileText aria-hidden="true" className="size-4" />
					Verträge
				</button>
				<button
					id="tab-api"
					type="button"
					role="tab"
					aria-selected={tab === "api"}
					aria-controls="panel-api"
					tabIndex={tab === "api" ? 0 : -1}
					onKeyDown={changeTab}
					className={`inline-flex items-center gap-2 border-b-2 px-4 py-3 text-sm transition-colors focus-visible:outline-2 focus-visible:outline-ring ${tab === "api" ? "border-primary font-medium text-primary" : "border-transparent text-muted-foreground hover:text-foreground"}`}
					onClick={() => setTab("api")}
				>
					<Code2 aria-hidden="true" className="size-4" />
					API & Verbindungen
				</button>
			</div>
			{tab === "contracts" ? (
				<section
					role="tabpanel"
					id="panel-contracts"
					aria-labelledby="tab-contracts"
					className="space-y-6"
				>
					{composing ? (
						<NewContract
							csrfToken={csrfToken}
							onCancel={() => setComposing(false)}
							onSent={(contract) => {
								setComposing(false);
								setSentContract(contract);
							}}
						/>
					) : null}
					{sentContract ? (
						<Alert role="status">
							<Check aria-hidden="true" className="size-4" />
							<AlertTitle>Vertrag versendet.</AlertTitle>
							<AlertDescription>
								Die Einladung für „{sentContract.title}“ wurde an{" "}
								{sentContract.recipients.map((recipient) => recipient.email).join(", ")} verschickt.
							</AlertDescription>
						</Alert>
					) : null}
					<div className="grid grid-cols-3 gap-3 sm:gap-5">
						{[
							{ label: "Verträge gesamt", value: total, Icon: FileText },
							{ label: "Unterschrift offen", value: open, Icon: FileClock },
							{ label: "Unterzeichnet", value: completed, Icon: FileCheck2 },
						].map(({ label, value, Icon }) => (
							<Panel key={label} className="space-y-4 p-4 sm:p-5">
								<div className="flex items-center justify-between gap-2">
									<span className="text-muted-foreground text-xs leading-5">{label}</span>
									<Icon
										aria-hidden="true"
										className="hidden size-4 text-muted-foreground sm:block"
									/>
								</div>
								<p className="font-medium text-3xl tabular-nums">{value ?? "–"}</p>
							</Panel>
						))}
					</div>
					<ContractsState query={contracts} onNew={startContract} />
				</section>
			) : (
				<section role="tabpanel" id="panel-api" aria-labelledby="tab-api">
					<ApiAccess csrfToken={csrfToken} />
				</section>
			)}
			<ConsoleFooter />
		</PageShell>
	);
}

interface ContractsStateProps {
	query: UseQueryResult<Contract[], Error>;
	onNew: () => void;
}

function ContractsState({ query, onNew }: ContractsStateProps) {
	if (query.isPending) return <LoadingText boxed>Verträge werden geladen…</LoadingText>;
	if (query.isError)
		return (
			<Alert variant="destructive">
				<AlertTitle>Verträge konnten nicht geladen werden</AlertTitle>
				<AlertDescription className="space-y-3">
					<p>{query.error.message}</p>
					<Button variant="outline" size="sm" onClick={() => query.refetch()}>
						<RefreshCw aria-hidden="true" />
						Erneut versuchen
					</Button>
				</AlertDescription>
			</Alert>
		);
	return <ContractList contracts={query.data} onNew={onNew} />;
}

interface LogoutStateProps {
	pending: boolean;
	error: Error | null;
	retry: () => void;
}

function LogoutState({ pending, error, retry }: LogoutStateProps) {
	return (
		<PageShell width="narrow" center>
			<ConsoleBrand />
			{pending ? (
				<LoadingText boxed>Du wirst sicher abgemeldet…</LoadingText>
			) : (
				<>
					<Alert variant="destructive">
						<AlertTitle>Abmeldung konnte nicht bestätigt werden</AlertTitle>
						<AlertDescription>{error?.message}</AlertDescription>
					</Alert>
					<Button onClick={retry}>Abmeldung erneut versuchen</Button>
				</>
			)}
			<ConsoleFooter />
		</PageShell>
	);
}
