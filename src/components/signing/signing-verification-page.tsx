import { Check, Loader2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { PageHeader, PageShell } from "@/components/layout/page-shell";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { useLanguage } from "@/lib/i18n";
import { signingCopy, signingError } from "./signing-copy";

interface SigningVerificationPageProps {
	token: string;
	onVerified?: (url: string) => void;
}

type VerificationState =
	| { status: "verifying" }
	| { status: "verified"; signingUrl: string }
	| { status: "error"; code?: string };

type SigningVerificationSuccess = {
	data: {
		signingLink: {
			url: string;
		};
	};
};

type SigningVerificationError = {
	error: {
		message: string;
		code?: string;
	};
};

const defaultOnVerified = (url: string) => {
	window.location.assign(url);
};

export function SigningVerificationPage({
	token,
	onVerified = defaultOnVerified,
}: SigningVerificationPageProps) {
	const { language } = useLanguage();
	const copy = signingCopy[language];
	const [state, setState] = useState<VerificationState>({ status: "verifying" });
	const apiUrl = useMemo(() => `/api/signing/verifications/${encodeURIComponent(token)}`, [token]);

	useEffect(() => {
		let cancelled = false;

		async function verify() {
			const response = await fetch(apiUrl);
			const json: unknown = await response.json().catch(() => null);
			if (cancelled) return;
			if (!response.ok || !isSigningVerificationSuccess(json)) {
				setState({
					status: "error",
					code: isSigningVerificationError(json) ? json.error.code : undefined,
				});
				return;
			}

			const signingUrl = json.data.signingLink.url;
			setState({ status: "verified", signingUrl });
			onVerified(signingUrl);
		}

		verify().catch(() => {
			if (!cancelled) setState({ status: "error" });
		});

		return () => {
			cancelled = true;
		};
	}, [apiUrl, onVerified]);

	return (
		<PageShell width="narrow">
			<PageHeader title={copy.verifyTitle} />

			{state.status === "verifying" ? (
				<Alert>
					<Loader2 className="size-4 animate-spin" />
					<AlertTitle>{copy.verifying}</AlertTitle>
				</Alert>
			) : null}

			{state.status === "verified" ? (
				<Alert>
					<Check className="size-4" />
					<AlertTitle>{copy.verified}</AlertTitle>
				</Alert>
			) : null}

			{state.status === "error" ? (
				<Alert variant="destructive" role="alert">
					<AlertTitle>{copy.verifyFailed}</AlertTitle>
					<AlertDescription>{signingError(language, state.code)}</AlertDescription>
				</Alert>
			) : null}

			{state.status === "verified" ? (
				<Button asChild>
					<a href={state.signingUrl}>{copy.toContract}</a>
				</Button>
			) : null}
		</PageShell>
	);
}

function isSigningVerificationSuccess(value: unknown): value is SigningVerificationSuccess {
	if (!value || typeof value !== "object" || !("data" in value)) return false;
	const data = value.data;
	return Boolean(data && typeof data === "object" && "signingLink" in data);
}

function isSigningVerificationError(value: unknown): value is SigningVerificationError {
	if (!value || typeof value !== "object" || !("error" in value)) return false;
	const error = value.error;
	return Boolean(error && typeof error === "object" && "message" in error);
}
