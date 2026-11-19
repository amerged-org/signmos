import { ArrowUpRight } from "lucide-react";
import { BrandHeader } from "@/components/layout/brand-header";

export function ConsoleBrand() {
	return <BrandHeader />;
}

export function ConsoleFooter() {
	return (
		<footer className="flex flex-wrap items-center justify-between gap-4 border-t border-foreground pt-5 font-mono text-[10px] uppercase tracking-[0.08em] text-muted-foreground">
			<span>
				amerged Sign
				<span aria-hidden="true" className="text-destructive">
					.
				</span>
			</span>
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
