import type * as React from "react";
import { cn } from "@/lib/utils";

export type StatusTone = "neutral" | "info" | "success" | "warning" | "destructive";

const statusTones: Record<StatusTone, string> = {
	neutral: "border-border bg-muted/60 text-muted-foreground",
	info: "border-foreground bg-background text-foreground",
	success: "border-foreground bg-foreground text-background",
	warning: "border-destructive bg-background text-destructive",
	destructive: "border-destructive bg-destructive text-white",
};

export function StatusBadge({
	tone = "neutral",
	className,
	children,
	...props
}: React.ComponentProps<"span"> & { tone?: StatusTone }) {
	return (
		<span
			data-slot="status-badge"
			className={cn(
				"inline-flex items-center gap-1.5 whitespace-nowrap border px-2.5 py-1 font-mono text-[10px] uppercase tracking-wide",
				statusTones[tone],
				className,
			)}
			{...props}
		>
			<span aria-hidden="true" className="size-1.5 shrink-0 bg-current" />
			{children}
		</span>
	);
}
