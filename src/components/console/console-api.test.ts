import { ConsoleRequestError, consoleErrorMessage, formatDate } from "./console-api";

it("formats dates in the selected language", () => {
	const timestamp = "2026-06-15T12:00:00.000Z";
	expect(formatDate(timestamp, "de")).toBe(
		new Intl.DateTimeFormat("de-DE", { dateStyle: "medium" }).format(new Date(timestamp)),
	);
	expect(formatDate(timestamp, "en")).toBe(
		new Intl.DateTimeFormat("en-GB", { dateStyle: "medium" }).format(new Date(timestamp)),
	);
	expect(formatDate(timestamp, "nl")).toBe(
		new Intl.DateTimeFormat("nl-NL", { dateStyle: "medium" }).format(new Date(timestamp)),
	);
});

it("localizes useful API recovery errors", () => {
	const error = new ConsoleRequestError(502, "provider details", "EMAIL_DELIVERY_FAILED");
	expect(consoleErrorMessage(error, "en")).toContain("Check the contract status");
	expect(consoleErrorMessage(error, "nl")).toContain("Controleer de contractstatus");
	expect(consoleErrorMessage(error, "de")).toContain("Vertragsstatus prüfen");
});
