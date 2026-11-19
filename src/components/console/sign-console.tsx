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
	consoleErrorMessage,
	consoleRequest,
	contractsOptions,
	mutationHeaders,
	sessionOptions,
} from "@/components/console/console-api";
import { ConsoleBrand, ConsoleFooter } from "@/components/console/console-brand";
import { ContractList } from "@/components/console/contract-list";
import { NewContract } from "@/components/console/new-contract";
import { PageShell } from "@/components/layout/page-shell";
import { LoadingText } from "@/components/patterns/loading-text";
import { Panel } from "@/components/patterns/panel";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { useLanguage } from "@/lib/i18n";
import { consoleCopy } from "./console-copy";

export function SignConsole() {
	const { language } = useLanguage();
	const t = consoleCopy[language];
	const session = useQuery(sessionOptions);
	useEffect(() => {
		if (session.data && !session.data.authenticated) window.location.replace("/login");
	}, [session.data]);
	if (session.isPending || (session.data && !session.data.authenticated))
		return (
			<PageShell width="narrow" center>
				<ConsoleBrand />
				<LoadingText boxed>{t.checking}</LoadingText>
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
					<AlertTitle>{t.loginError}</AlertTitle>
					<AlertDescription>{t.loginAgain}</AlertDescription>
				</Alert>
				<Button asChild>
					<a href="/login">{t.login}</a>
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
	const { language } = useLanguage();
	const t = consoleCopy[language];
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
			<header className="flex flex-wrap items-center justify-between gap-5 border-b border-foreground pb-6">
				<ConsoleBrand />
				<div className="flex items-center gap-3">
					<span className="max-w-48 truncate font-mono text-[10px] text-muted-foreground sm:max-w-none">
						{session.email}
					</span>
					<Button
						variant="ghost"
						size="sm"
						aria-label={t.logout}
						onClick={() => logout.mutate()}
						disabled={logout.isPending}
					>
						<LogOut aria-hidden="true" />
						<span className="hidden sm:inline">{logout.isPending ? t.loggingOut : t.logout}</span>
						<span className="sr-only sm:hidden">{t.logout}</span>
					</Button>
				</div>
			</header>
			<div className="flex flex-wrap items-end justify-between gap-6 py-5 sm:py-8">
				<div className="max-w-2xl space-y-4">
					<p className="font-mono text-[10px] uppercase tracking-[0.12em] text-muted-foreground">
						<span className="text-destructive">01 /</span> {t.workspace}
					</p>
					<h1 className="text-balance font-serif text-4xl font-normal leading-[1.1] tracking-[-0.035em] sm:text-5xl">
						{t.heading}
					</h1>
				</div>
				<Button size="lg" onClick={startContract}>
					<Plus aria-hidden="true" />
					{t.sendContract}
				</Button>
			</div>
			<div
				className="flex gap-2 border-b border-foreground"
				role="tablist"
				aria-label={t.workspace}
			>
				<button
					id="tab-contracts"
					type="button"
					role="tab"
					aria-selected={tab === "contracts"}
					aria-controls="panel-contracts"
					tabIndex={tab === "contracts" ? 0 : -1}
					onKeyDown={changeTab}
					className={`inline-flex min-h-12 items-center gap-2 border-b-2 px-3 py-3 font-mono text-[11px] uppercase tracking-[0.06em] transition-colors focus-visible:outline-2 focus-visible:outline-ring ${tab === "contracts" ? "border-destructive text-foreground" : "border-transparent text-muted-foreground hover:text-foreground"}`}
					onClick={() => setTab("contracts")}
				>
					<FileText aria-hidden="true" className="size-4" />
					{t.contracts}
				</button>
				<button
					id="tab-api"
					type="button"
					role="tab"
					aria-selected={tab === "api"}
					aria-controls="panel-api"
					tabIndex={tab === "api" ? 0 : -1}
					onKeyDown={changeTab}
					className={`inline-flex min-h-12 items-center gap-2 border-b-2 px-3 py-3 font-mono text-[11px] uppercase tracking-[0.06em] transition-colors focus-visible:outline-2 focus-visible:outline-ring ${tab === "api" ? "border-destructive text-foreground" : "border-transparent text-muted-foreground hover:text-foreground"}`}
					onClick={() => setTab("api")}
				>
					<Code2 aria-hidden="true" className="size-4" />
					{t.api}
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
							<AlertTitle>{t.sent}</AlertTitle>
							<AlertDescription>
								{t.sentTo}: {sentContract.recipients.map((recipient) => recipient.email).join(", ")}
							</AlertDescription>
						</Alert>
					) : null}
					<div className="grid grid-cols-3 gap-4 sm:gap-8">
						{[
							{ label: t.total, value: total, Icon: FileText },
							{ label: t.open, value: open, Icon: FileClock },
							{ label: t.signed, value: completed, Icon: FileCheck2 },
						].map(({ label, value, Icon }) => (
							<Panel
								key={label}
								className="space-y-4 rounded-none border-0 border-t border-foreground p-0 pt-4 shadow-none sm:p-0 sm:pt-4"
							>
								<div className="flex items-center justify-between gap-2">
									<span className="font-mono text-[10px] uppercase leading-5 tracking-[0.06em] text-muted-foreground">
										{label}
									</span>
									<Icon
										aria-hidden="true"
										className="hidden size-4 text-muted-foreground sm:block"
									/>
								</div>
								<p className="font-serif text-4xl tabular-nums">{value ?? "–"}</p>
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
	const { language } = useLanguage();
	const t = consoleCopy[language];
	if (query.isPending) return <LoadingText boxed>{t.loading}</LoadingText>;
	if (query.isError)
		return (
			<Alert variant="destructive">
				<AlertTitle>{t.loadingError}</AlertTitle>
				<AlertDescription className="space-y-3">
					<p>{consoleErrorMessage(query.error, language)}</p>
					<Button variant="outline" size="sm" onClick={() => query.refetch()}>
						<RefreshCw aria-hidden="true" />
						{t.retry}
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
	const { language } = useLanguage();
	const t = consoleCopy[language];
	return (
		<PageShell width="narrow" center>
			<ConsoleBrand />
			{pending ? (
				<LoadingText boxed>{t.loggingOut}</LoadingText>
			) : (
				<>
					<Alert variant="destructive">
						<AlertTitle>{t.logoutError}</AlertTitle>
						<AlertDescription>{consoleErrorMessage(error, language)}</AlertDescription>
					</Alert>
					<Button onClick={retry}>{t.retry}</Button>
				</>
			)}
			<ConsoleFooter />
		</PageShell>
	);
}
