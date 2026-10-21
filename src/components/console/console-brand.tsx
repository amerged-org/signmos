import { ArrowUpRight } from "lucide-react";

export function ConsoleBrand() {
	return (
		<a
			href="/"
			className="inline-flex items-baseline gap-2 text-foreground"
			aria-label="amerged Sign Startseite"
		>
			<span className="font-serif text-3xl tracking-tight">
				amerged<span className="text-destructive">.</span>
			</span>
			<span className="border-l pl-2 text-[11px] font-medium uppercase tracking-[0.24em]">
				Sign
			</span>
		</a>
	);
}

export function ConsoleFooter() {
	return (
		<footer className="flex flex-wrap items-center justify-between gap-3 border-t pt-6 text-muted-foreground text-xs">
			<span>amerged Sign · Verträge in guten Händen.</span>
			<a
				href="https://amerged.com"
				className="inline-flex items-center gap-1 underline-offset-4 hover:underline"
				target="_blank"
				rel="noreferrer"
			>
				amerged.com <ArrowUpRight aria-hidden="true" className="size-3" />
			</a>
		</footer>
	);
}
