import { useLanguage } from "@/lib/i18n";
import { cn } from "@/lib/utils";

function WordmarkContent() {
	return (
		<>
			<img
				src="/assets/amerged-wordmark.svg"
				alt="amerged"
				width="195"
				height="35"
				className="h-auto w-[clamp(100px,34vw,156px)] sm:w-[176px]"
			/>
			<span className="hidden border-l border-border pl-3 font-mono text-[10px] uppercase tracking-[0.1em] text-muted-foreground min-[360px]:inline">
				Sign
			</span>
		</>
	);
}

export function Wordmark({ linked = true, className }: { linked?: boolean; className?: string }) {
	const { language } = useLanguage();
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
			aria-label={
				{ de: "amerged Sign Startseite", en: "amerged Sign home", nl: "amerged Sign startpagina" }[
					language
				]
			}
			className={cn(
				"inline-flex items-center gap-2 rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:ring-offset-2",
				className,
			)}
		>
			<WordmarkContent />
		</a>
	);
}
