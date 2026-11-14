import { useForm } from "@tanstack/react-form";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Check } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { z } from "zod";
import { PageHeader, PageShell } from "@/components/layout/page-shell";
import { LoadingText } from "@/components/patterns/loading-text";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useLanguage } from "@/lib/i18n";
import { signingCopy, signingError } from "./signing-copy";

interface SigningVerificationPageProps {
	token: string;
	emailHint?: string;
	onVerified?: (url: string) => void;
}

const inspectionSchema = z.object({ emailHint: z.string() });
const requestSchema = z.object({
	emailHint: z.string(),
	expiresInSeconds: z.number().nonnegative(),
	retryAfterSeconds: z.number().nonnegative(),
});
const verificationSchema = z.object({ verified: z.literal(true), signingUrl: z.string() });
const errorSchema = z.object({ error: z.object({ code: z.string().optional() }) });

class VerificationError extends Error {
	constructor(
		readonly code?: string,
		readonly retryAt = 0,
	) {
		super("Email verification failed");
	}
}

interface CodeRequest {
	emailHint: string;
	expiresAt: number;
	resendAt: number;
}

const defaultOnVerified = (url: string) => window.location.assign(url);

export function SigningVerificationPage({
	token,
	emailHint: initialEmailHint,
	onVerified = defaultOnVerified,
}: SigningVerificationPageProps) {
	const { language } = useLanguage();
	const copy = signingCopy[language];
	const endpoint = `/api/signing/${encodeURIComponent(token)}/email-code`;
	const inspection = useQuery<z.infer<typeof inspectionSchema>, VerificationError>({
		queryKey: ["signer-email-verification", token],
		queryFn: () =>
			readResponse(
				fetch(`/api/signing/verifications/${encodeURIComponent(token)}`),
				inspectionSchema,
			),
		enabled: !initialEmailHint,
		retry: false,
		gcTime: 0,
		refetchOnWindowFocus: false,
	});
	const request = useMutation<CodeRequest, VerificationError>({
		mutationFn: async () => {
			const data = await readResponse(post(`${endpoint}/request`, {}), requestSchema);
			return {
				emailHint: data.emailHint,
				expiresAt: Date.now() + data.expiresInSeconds * 1000,
				resendAt: Date.now() + data.retryAfterSeconds * 1000,
			};
		},
	});
	const verification = useMutation<z.infer<typeof verificationSchema>, VerificationError, string>({
		mutationFn: (code: string) =>
			readResponse(post(`${endpoint}/verify`, { code }), verificationSchema),
		onSuccess: (data) => onVerified(data.signingUrl),
	});

	const now = useClock(request.data?.expiresAt, request.error?.retryAt);
	const expiresIn = secondsUntil(request.data?.expiresAt, now);
	const resendIn = secondsUntil(request.error?.retryAt || request.data?.resendAt, now);
	const emailHint = request.data?.emailHint ?? initialEmailHint ?? inspection.data?.emailHint;
	const error = inspection.error ?? request.error ?? verification.error;

	function sendCode() {
		verification.reset();
		request.mutate();
	}

	return (
		<PageShell width="narrow">
			<PageHeader title={copy.verifyTitle} />
			{!initialEmailHint && inspection.isPending ? (
				<LoadingText>{copy.verifying}</LoadingText>
			) : null}
			{verification.isSuccess ? (
				<>
					<Alert role="status">
						<Check className="size-4" aria-hidden="true" />
						<AlertTitle>{copy.verified}</AlertTitle>
					</Alert>
					<Button asChild>
						<a href={verification.data.signingUrl}>{copy.toContract}</a>
					</Button>
				</>
			) : emailHint ? (
				<VerificationPrompt
					emailHint={emailHint}
					expiresIn={request.data ? expiresIn : undefined}
					resendIn={resendIn}
					requestPending={request.isPending}
					verificationPending={verification.isPending}
					onSend={sendCode}
					onVerify={(code) => verification.mutate(code)}
					codeKey={request.data?.expiresAt}
				/>
			) : null}
			{error ? (
				<Alert variant="destructive" role="alert">
					<AlertTitle>{copy.verifyFailed}</AlertTitle>
					<AlertDescription>{signingError(language, error.code)}</AlertDescription>
				</Alert>
			) : null}
		</PageShell>
	);
}

interface VerificationPromptProps {
	emailHint: string;
	expiresIn?: number;
	resendIn: number;
	requestPending: boolean;
	verificationPending: boolean;
	onSend: () => void;
	onVerify: (code: string) => void;
	codeKey?: number;
}

function VerificationPrompt(props: VerificationPromptProps) {
	const { language } = useLanguage();
	const copy = signingCopy[language];
	return (
		<div className="space-y-6">
			<p className="text-muted-foreground">
				{copy.codeTo} <span className="font-medium text-foreground">{props.emailHint}</span>
			</p>
			{props.expiresIn === undefined ? (
				<SendCodeButton {...props} />
			) : (
				<EmailCodeForm key={props.codeKey} {...props} expiresIn={props.expiresIn} />
			)}
		</div>
	);
}

function EmailCodeForm(props: VerificationPromptProps & { expiresIn: number }) {
	const { language } = useLanguage();
	const copy = signingCopy[language];
	const codeRef = useRef<HTMLInputElement>(null);
	const form = useForm({
		defaultValues: { code: "" },
		onSubmit: ({ value }) => props.onVerify(value.code.trim()),
	});
	useEffect(() => codeRef.current?.focus(), []);
	return (
		<form
			className="space-y-5"
			onSubmit={(event) => {
				event.preventDefault();
				void form.handleSubmit();
			}}
			noValidate
		>
			<form.Field
				name="code"
				validators={{
					onSubmit: ({ value }) => (/^\d{6}$/.test(value.trim()) ? undefined : "invalid"),
				}}
			>
				{(field) => (
					<div className="space-y-2">
						<Label htmlFor="signing-email-code">{copy.codeLabel}</Label>
						<Input
							ref={codeRef}
							id="signing-email-code"
							name={field.name}
							inputMode="numeric"
							autoComplete="one-time-code"
							maxLength={6}
							value={field.state.value}
							onChange={(event) => field.handleChange(event.target.value)}
							onBlur={field.handleBlur}
							aria-invalid={field.state.meta.errors.length > 0}
							aria-describedby="signing-code-help signing-code-error"
							className="max-w-60 font-mono text-xl tracking-[0.25em]"
						/>
						{field.state.meta.errors.length > 0 ? (
							<p id="signing-code-error" role="alert" className="text-sm text-destructive">
								{copy.invalidCode}
							</p>
						) : null}
					</div>
				)}
			</form.Field>
			<p id="signing-code-help" className="text-sm text-muted-foreground">
				{props.expiresIn > 0
					? copy.codeExpiry.replace("{time}", formatTime(props.expiresIn))
					: copy.codeExpired}
			</p>
			<div className="flex flex-wrap gap-3">
				<Button
					type="submit"
					disabled={props.verificationPending || props.requestPending || props.expiresIn === 0}
				>
					{props.verificationPending ? copy.verifying : copy.confirmCode}
				</Button>
				<SendCodeButton {...props} resend />
			</div>
		</form>
	);
}

function SendCodeButton({
	requestPending,
	verificationPending,
	resendIn,
	onSend,
	resend = false,
}: Pick<
	VerificationPromptProps,
	"requestPending" | "verificationPending" | "resendIn" | "onSend"
> & {
	resend?: boolean;
}) {
	const { language } = useLanguage();
	const copy = signingCopy[language];
	const label = requestPending
		? copy.sendingCode
		: resendIn > 0
			? copy.resendIn.replace("{seconds}", String(resendIn))
			: resend
				? copy.resendCode
				: copy.sendCode;
	return (
		<Button
			type="button"
			variant={resend ? "outline" : "default"}
			onClick={onSend}
			disabled={requestPending || verificationPending || resendIn > 0}
		>
			{label}
		</Button>
	);
}

function post(url: string, body: object) {
	return fetch(url, {
		method: "POST",
		credentials: "same-origin",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(body),
	});
}

async function readResponse<T>(promise: Promise<Response>, schema: z.ZodType<T>): Promise<T> {
	let response: Response;
	try {
		response = await promise;
	} catch {
		throw new VerificationError();
	}
	const body: unknown = await response.json().catch(() => null);
	const parsed = schema.safeParse(
		body && typeof body === "object" && "data" in body ? body.data : null,
	);
	if (!response.ok || !parsed.success) {
		const error = errorSchema.safeParse(body);
		const retryAfter = Number(response.headers.get("Retry-After"));
		throw new VerificationError(
			error.success ? error.data.error.code : undefined,
			retryAfter > 0 ? Date.now() + retryAfter * 1000 : 0,
		);
	}
	return parsed.data;
}

function useClock(expiresAt?: number, retryAt?: number) {
	const [now, setNow] = useState(Date.now);
	useEffect(() => {
		if (!expiresAt && !retryAt) return;
		setNow(Date.now());
		const timer = window.setInterval(() => setNow(Date.now()), 1000);
		return () => window.clearInterval(timer);
	}, [expiresAt, retryAt]);
	return now;
}

function secondsUntil(deadline: number | undefined, now: number) {
	return Math.max(0, Math.ceil(((deadline ?? 0) - now) / 1000));
}

function formatTime(seconds: number) {
	return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}
