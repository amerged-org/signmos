import { LanguageSwitcher } from "@/components/layout/language-switcher";
import { Wordmark } from "@/components/layout/wordmark";
import { cn } from "@/lib/utils";

/** Keep the brand and language controls together without nesting interactive elements. */
export function BrandHeader({
	linked = true,
	className,
}: {
	linked?: boolean;
	className?: string;
}) {
	return (
		<div
			data-slot="brand-header"
			className={cn("flex w-full items-center justify-between gap-2", className)}
		>
			<Wordmark linked={linked} />
			<LanguageSwitcher />
		</div>
	);
}
