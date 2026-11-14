import { type Language, useLanguage } from "@/lib/i18n";

const languages: Array<{ code: Language; name: string }> = [
	{ code: "de", name: "Deutsch" },
	{ code: "en", name: "English" },
	{ code: "nl", name: "Nederlands" },
];

export function LanguageSwitcher() {
	const { language, setLanguage } = useLanguage();
	return (
		<nav
			aria-label="Sprache / Language / Taal"
			className="flex items-center gap-3 font-mono text-[11px] tracking-wide"
		>
			{languages.map(({ code, name }) => (
				<button
					key={code}
					type="button"
					lang={code}
					aria-label={name}
					aria-pressed={language === code}
					onClick={() => setLanguage(code)}
					className={
						language === code
							? "min-h-11 min-w-11 border-b-2 border-destructive text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-destructive"
							: "min-h-11 min-w-11 border-b-2 border-transparent text-muted-foreground hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-destructive"
					}
				>
					{code.toUpperCase()}
				</button>
			))}
		</nav>
	);
}
