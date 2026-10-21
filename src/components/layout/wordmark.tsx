import { cn } from "@/lib/utils";

function WordmarkContent() {
	return (
		<>
			<span className="font-serif text-2xl text-foreground tracking-tight">
				amerged<span className="text-destructive">.</span>
			</span>
			<span className="border-l pl-2 text-[11px] font-medium uppercase tracking-[0.24em]">
				Sign
			</span>
		</>
	);
}

export function Wordmark({ linked = true, className }: { linked?: boolean; className?: string }) {
	if (!linked) {
		return (
			<span className={cn("inline-flex items-center gap-2", className)}>
				<WordmarkContent />
			</span>
		);
	}
	return (
		<a
			href="/"
			aria-label="amerged Sign Startseite"
			className={cn(
				"inline-flex items-center gap-2 rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:ring-offset-2",
				className,
			)}
		>
			<WordmarkContent />
		</a>
	);
}
