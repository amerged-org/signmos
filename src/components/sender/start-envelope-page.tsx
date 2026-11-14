import { useForm } from "@tanstack/react-form";
import {
	ArrowRight,
	Bot,
	FileSignature,
	Files,
	type LucideIcon,
	Send,
	UsersRound,
} from "lucide-react";
import { type FormEvent, type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { AgenticAccessRequestForm } from "@/components/agentic/agentic-access-request-form";
import { HistoryRequestForm } from "@/components/history/history-request-form";
import { BrandHeader } from "@/components/layout/brand-header";
import { PageHeader, PageShell } from "@/components/layout/page-shell";
import {
	type ProductMode,
	ProductModeNavigation,
} from "@/components/navigation/product-mode-navigation";
import { Panel } from "@/components/patterns/panel";
import { BackLink } from "@/components/patterns/text-link";
import { readTurnstileToken, TurnstileWidget } from "@/components/turnstile-widget";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

interface StartEnvelopePageProps {
	initialTask?: ProductMode;
	historyReturnTo?: string;
	turnstileSiteKey?: string;
	testTurnstileToken?: string;
}

type SigningMode = "only_me" | "me_and_another_signer";
type LandingTask = ProductMode;

const landingTaskHistoryStateKey = "signmosLandingTask";

const landingTaskChoices = [
	{
		task: "only_me",
		label: "Sign by myself",
		description: "Upload and sign your PDF",
		icon: FileSignature,
	},
	{
		task: "me_and_another_signer",
		label: "Sign with someone else",
		description: "Add one other signer",
		icon: UsersRound,
	},
	{
		task: "my_documents",
		label: "My documents",
		description: "View and manage your PDFs",
		icon: Files,
	},
	{
		task: "agentic",
		label: "Agentic mode",
		description: "Connect Signmos to an agent",
		icon: Bot,
	},
] as const satisfies ReadonlyArray<{
	task: LandingTask;
	label: string;
	description: string;
	icon: LucideIcon;
}>;

const landingTaskHeroContent = {
	only_me: {
		heading: "Sign a PDF by yourself",
		description:
			"Enter your details, verify your email, then upload, prepare, and sign your document.",
	},
	me_and_another_signer: {
		heading: "Sign a PDF with someone else",
		description:
			"Enter your details, verify your email, then upload your document and add the other signer.",
	},
	my_documents: {
		heading: "Access your documents",
		description: "Enter your email to receive a secure link to view and manage your PDFs.",
	},
	agentic: {
		heading: "Connect Signmos to an agent",
		description: "Verify your email to create and manage personal API tokens for your agent.",
	},
} as const satisfies Record<LandingTask, { heading: string; description: string }>;

const taskChooserHeroContent = {
	heading: "Sign a PDF without an account",
	description: "Choose how you’d like to get started.",
} as const;

type StartFormValues = {
	signingMode: SigningMode;
	name: string;
	email: string;
};

const startFormDefaults: StartFormValues = {
	signingMode: "only_me",
	name: "",
	email: "",
};

type StartState =
	| { status: "idle" }
	| { status: "submitting" }
	| { status: "success"; response: SenderStartSuccess["data"] }
	| { status: "error"; message: string };

type SenderStartSuccess = {
	data: {
		envelopeId: string;
		status: "awaiting_verification";
		sender: {
			name: string;
			email: string;
		};
		verification: {
			email: string;
			expiresAt: string;
		};
	};
};

type SenderStartError = {
	error: {
		code: string;
		message: string;
		providerMessage?: string;
	};
};

export function StartEnvelopePage({
	initialTask,
	historyReturnTo,
	turnstileSiteKey,
	testTurnstileToken = "",
}: StartEnvelopePageProps) {
	const [activeTask, setActiveTask] = useState<LandingTask | null>(initialTask ?? null);
	const [state, setState] = useState<StartState>({ status: "idle" });
	const idempotencyKey = useMemo(() => crypto.randomUUID(), []);
	const pendingTurnstileTokenRef = useRef("");
	const activeTurnstileSiteKey = turnstileSiteKey?.trim() ?? "";
	const activeTestTurnstileToken = testTurnstileToken.trim();
	const hasTurnstileConfig =
		activeTurnstileSiteKey.length > 0 || activeTestTurnstileToken.length > 0;
	const form = useForm({
		defaultValues: startFormDefaults,
		onSubmit: ({ value }) => submitStart(value, pendingTurnstileTokenRef.current),
	});

	useEffect(() => {
		function handlePopState(event: PopStateEvent) {
			setActiveTask(readLandingTaskHistoryState(event.state) ?? initialTask ?? null);
			setState({ status: "idle" });
		}

		window.addEventListener("popstate", handlePopState);
		return () => window.removeEventListener("popstate", handlePopState);
	}, [initialTask]);

	function chooseTask(task: LandingTask) {
		pushLandingTaskHistoryState(task);
		if (task === "only_me" || task === "me_and_another_signer") {
			form.setFieldValue("signingMode", task);
		}
		setActiveTask(task);
	}

	function submitForm(event: FormEvent<HTMLFormElement>) {
		event.preventDefault();
		const formData = new FormData(event.currentTarget);
		const widgetToken = formData.get("cf-turnstile-response");
		const turnstileToken = readTurnstileToken(widgetToken, activeTestTurnstileToken);
		if (!turnstileToken) {
			setState({
				status: "error",
				message: activeTurnstileSiteKey
					? "Complete the Turnstile challenge before starting."
					: "Turnstile is not configured for this environment.",
			});
			return;
		}

		pendingTurnstileTokenRef.current = turnstileToken;
		void form.handleSubmit();
	}

	async function submitStart(values: StartFormValues, turnstileToken: string) {
		setState({ status: "submitting" });
		try {
			const response = await fetch("/api/envelopes/sender-start", {
				method: "POST",
				headers: {
					"content-type": "application/json",
					"idempotency-key": idempotencyKey,
				},
				body: JSON.stringify({ ...values, turnstileToken }),
			});
			const json: unknown = await response.json().catch(() => null);
			if (!response.ok || !isSenderStartSuccess(json)) {
				const message = isSenderStartError(json)
					? (json.error.providerMessage ?? json.error.message)
					: "Unable to start the envelope";
				setState({ status: "error", message });
				return;
			}

			setState({ status: "success", response: json.data });
		} catch {
			setState({ status: "error", message: "Unable to start the envelope" });
		}
	}

	function returnToTaskChooser() {
		setActiveTask(null);
		setState({ status: "idle" });
		if (readLandingTaskHistoryState(window.history.state) !== null) {
			window.history.back();
		}
	}

	const isTaskChooserVisible = activeTask === null;
	const activeTaskHeroContent = getLandingTaskHeroContent(activeTask);

	if (isTaskChooserVisible) {
		return (
			<PageShell width="content" center>
				<div className="mx-auto max-w-2xl text-center">
					<BrandHeader linked={false} />
					<h1 className="mt-6 text-balance font-semibold text-4xl text-foreground sm:text-5xl">
						{taskChooserHeroContent.heading}
					</h1>
					<p className="mx-auto mt-5 max-w-xl text-pretty text-muted-foreground leading-7">
						{taskChooserHeroContent.description}
					</p>
				</div>
				<LandingTaskChooser onChoose={chooseTask} />
			</PageShell>
		);
	}

	return (
		<PageShell width="wide">
			<ProductModeNavigation activeMode={activeTask} />
			<section className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_420px] lg:items-start">
				<PageHeader
					className="lg:pt-10"
					title={activeTaskHeroContent.heading}
					lead={activeTaskHeroContent.description}
				/>

				<LandingTaskPanel
					activeTask={activeTask}
					historyReturnTo={historyReturnTo}
					onBack={returnToTaskChooser}
					onChoose={chooseTask}
					turnstileSiteKey={activeTurnstileSiteKey}
					testTurnstileToken={activeTestTurnstileToken}
				>
					<Panel as="form" aria-label="Start envelope" onSubmit={submitForm}>
						<BackLink onClick={returnToTaskChooser} className="mb-5">
							Back to task choices
						</BackLink>
						<div className="space-y-5">
							<form.Field name="name">
								{(field) => (
									<div className="space-y-2">
										<Label htmlFor="sender-name">Name</Label>
										<Input
											id="sender-name"
											name={field.name}
											autoComplete="name"
											value={field.state.value}
											onBlur={field.handleBlur}
											onChange={(event) => field.handleChange(event.target.value)}
											required
										/>
									</div>
								)}
							</form.Field>
							<form.Field name="email">
								{(field) => (
									<div className="space-y-2">
										<Label htmlFor="sender-email">Email</Label>
										<Input
											id="sender-email"
											name={field.name}
											type="email"
											autoComplete="email"
											value={field.state.value}
											onBlur={field.handleBlur}
											onChange={(event) => field.handleChange(event.target.value)}
											required
										/>
									</div>
								)}
							</form.Field>

							{activeTurnstileSiteKey ? <TurnstileWidget siteKey={activeTurnstileSiteKey} /> : null}

							{!hasTurnstileConfig ? (
								<Alert variant="destructive" role="alert">
									<AlertTitle>Turnstile is not configured</AlertTitle>
									<AlertDescription>
										Set TURNSTILE_SITE_KEY in .dev.vars and restart the dev server.
									</AlertDescription>
								</Alert>
							) : null}

							{state.status === "error" ? (
								<Alert variant="destructive" role="alert">
									<AlertTitle>Start failed</AlertTitle>
									<AlertDescription>{state.message}</AlertDescription>
								</Alert>
							) : null}

							{state.status === "success" ? (
								<Alert>
									<AlertTitle>Check your email</AlertTitle>
									<AlertDescription>
										Verification was sent to {state.response.sender.email}.
									</AlertDescription>
								</Alert>
							) : null}

							<Button
								type="submit"
								className="w-full"
								disabled={state.status === "submitting" || !hasTurnstileConfig}
							>
								<Send aria-hidden="true" className="size-4" />
								{state.status === "submitting" ? "Starting…" : "Start envelope"}
							</Button>
						</div>
					</Panel>
				</LandingTaskPanel>
			</section>
		</PageShell>
	);
}

function getLandingTaskHeroContent(activeTask: LandingTask | null): {
	heading: string;
	description: string;
} {
	if (activeTask === null) return taskChooserHeroContent;
	return landingTaskHeroContent[activeTask];
}

function pushLandingTaskHistoryState(task: LandingTask) {
	const currentState: unknown = window.history.state;
	const preservedState = isRecord(currentState) ? currentState : {};
	window.history.pushState({ ...preservedState, [landingTaskHistoryStateKey]: task }, "");
}

function readLandingTaskHistoryState(state: unknown): LandingTask | null {
	if (!isRecord(state)) return null;
	const task = state[landingTaskHistoryStateKey];
	return isLandingTask(task) ? task : null;
}

function isLandingTask(value: unknown): value is LandingTask {
	return (
		value === "only_me" ||
		value === "me_and_another_signer" ||
		value === "my_documents" ||
		value === "agentic"
	);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function LandingTaskPanel({
	activeTask,
	children,
	historyReturnTo,
	onBack,
	onChoose,
	turnstileSiteKey,
	testTurnstileToken,
}: {
	activeTask: LandingTask | null;
	children: ReactNode;
	historyReturnTo?: string;
	onBack: () => void;
	onChoose: (task: LandingTask) => void;
	turnstileSiteKey: string;
	testTurnstileToken: string;
}) {
	if (activeTask === null) return <LandingTaskChooser onChoose={onChoose} />;
	if (activeTask === "my_documents") {
		return (
			<HistoryRequestForm
				returnTo={historyReturnTo}
				onBack={onBack}
				turnstileSiteKey={turnstileSiteKey}
				testTurnstileToken={testTurnstileToken}
			/>
		);
	}
	if (activeTask === "agentic") {
		return (
			<AgenticAccessRequestForm
				onBack={onBack}
				turnstileSiteKey={turnstileSiteKey}
				testTurnstileToken={testTurnstileToken}
			/>
		);
	}
	return children;
}

function LandingTaskChooser({ onChoose }: { onChoose: (task: LandingTask) => void }) {
	return (
		<fieldset className="grid gap-3 sm:grid-cols-2">
			<legend className="sr-only">Choose a task</legend>
			{landingTaskChoices.map(({ task, label, description, icon: Icon }) => (
				<button
					key={task}
					type="button"
					aria-label={label}
					onClick={() => onChoose(task)}
					className="group flex min-h-28 items-center justify-between gap-3 rounded-xl border bg-card p-5 text-left shadow-xs outline-none transition-colors hover:border-ring/50 focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
				>
					<span className="flex min-w-0 items-start gap-4">
						<span className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
							<Icon aria-hidden="true" className="size-5" />
						</span>
						<span className="min-w-0">
							<span className="block font-semibold text-base text-foreground">{label}</span>
							<span className="mt-1 block text-pretty text-muted-foreground text-sm">
								{description}
							</span>
						</span>
					</span>
					<ArrowRight
						aria-hidden="true"
						className="size-4 shrink-0 text-muted-foreground transition-colors group-hover:text-foreground"
					/>
				</button>
			))}
		</fieldset>
	);
}

function isSenderStartSuccess(value: unknown): value is SenderStartSuccess {
	if (!value || typeof value !== "object" || !("data" in value)) return false;
	const data = value.data;
	return Boolean(data && typeof data === "object" && "verification" in data);
}

function isSenderStartError(value: unknown): value is SenderStartError {
	if (!value || typeof value !== "object" || !("error" in value)) return false;
	const error = value.error;
	return Boolean(error && typeof error === "object" && "message" in error);
}
