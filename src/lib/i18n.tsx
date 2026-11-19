import {
	createContext,
	type ReactNode,
	useCallback,
	useContext,
	useEffect,
	useMemo,
	useState,
} from "react";

export type Language = "de" | "en" | "nl";
const STORAGE_KEY = "amerged-sign-language";

interface LanguageContextValue {
	language: Language;
	setLanguage: (language: Language) => void;
}

const LanguageContext = createContext<LanguageContextValue>({
	language: "de",
	setLanguage: () => {},
});

function isLanguage(value: string | null | undefined): value is Language {
	return value === "de" || value === "en" || value === "nl";
}

function persistLanguage(next: Language): void {
	try {
		window.localStorage.setItem(STORAGE_KEY, next);
	} catch {
		// A blocked localStorage must not prevent switching languages.
	}
}

/** Start with the same language on server and client, then restore the browser preference. */
export function LanguageProvider({ children }: { children: ReactNode }) {
	const [language, updateLanguage] = useState<Language>("de");

	useEffect(() => {
		try {
			const stored = window.localStorage.getItem(STORAGE_KEY);
			if (isLanguage(stored)) updateLanguage(stored);
		} catch {
			// Storage can be disabled in private browsing; switching still works in memory.
		}
		const onStorage = (event: StorageEvent) => {
			if (event.key === STORAGE_KEY && isLanguage(event.newValue)) updateLanguage(event.newValue);
		};
		window.addEventListener("storage", onStorage);
		return () => window.removeEventListener("storage", onStorage);
	}, []);
	useEffect(() => {
		document.documentElement.lang = language;
	}, [language]);

	const setLanguage = useCallback((next: Language) => {
		updateLanguage(next);
		persistLanguage(next);
	}, []);

	const value = useMemo(() => ({ language, setLanguage }), [language, setLanguage]);
	return <LanguageContext.Provider value={value}>{children}</LanguageContext.Provider>;
}

export function useLanguage(): LanguageContextValue {
	return useContext(LanguageContext);
}
