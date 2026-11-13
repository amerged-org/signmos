import { Download, FileText, Search } from "lucide-react";
import { useState } from "react";
import { type Contract, formatDate } from "@/components/console/console-api";
import { EmptyState } from "@/components/patterns/empty-state";
import { NativeSelect } from "@/components/patterns/native-select";
import { Panel, PanelTitle } from "@/components/patterns/panel";
import { StatusBadge, type StatusTone } from "@/components/patterns/status-badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

interface ContractListProps {
	contracts: Contract[];
	onNew: () => void;
}

const statuses: Record<string, { label: string; tone: StatusTone }> = {
	draft: { label: "Entwurf", tone: "neutral" },
	preparing: { label: "In Vorbereitung", tone: "neutral" },
	queued: { label: "Versand vorbereitet", tone: "info" },
	delivery_failed: { label: "Versand fehlgeschlagen", tone: "warning" },
	manual_review: { label: "Prüfung erforderlich", tone: "destructive" },
	awaiting_verification: { label: "Bestätigung ausstehend", tone: "warning" },
	sent: { label: "Zur Unterschrift", tone: "info" },
	in_progress: { label: "In Bearbeitung", tone: "info" },
	changes_requested: { label: "Änderung angefragt", tone: "warning" },
	completed: { label: "Unterzeichnet", tone: "success" },
	declined: { label: "Abgelehnt", tone: "destructive" },
	expired: { label: "Abgelaufen", tone: "neutral" },
	cancelled: { label: "Zurückgezogen", tone: "neutral" },
	deleted: { label: "Gelöscht", tone: "neutral" },
};

export function ContractList({ contracts, onNew }: ContractListProps) {
	const [search, setSearch] = useState("");
	const [status, setStatus] = useState("all");
	const normalized = search.toLocaleLowerCase("de-DE").trim();
	const visible = contracts.filter(
		(contract) =>
			(status === "all" ||
				(status === "open"
					? !["completed", "declined", "expired", "cancelled", "deleted"].includes(contract.status)
					: contract.status === status)) &&
			(!normalized ||
				`${contract.title} ${contract.recipients.map((recipient) => `${recipient.name ?? ""} ${recipient.email}`).join(" ")}`
					.toLocaleLowerCase("de-DE")
					.includes(normalized)),
	);

	return (
		<Panel className="space-y-6 rounded-none border-0 border-t border-foreground p-0 pt-6 shadow-none sm:p-0 sm:pt-6">
			<div className="flex flex-wrap items-center justify-between gap-3">
				<PanelTitle className="font-serif text-2xl font-normal">Alle Verträge</PanelTitle>
				<span className="font-mono text-[10px] uppercase tracking-[0.06em] text-muted-foreground tabular-nums">
					{contracts.length} {contracts.length === 1 ? "Vertrag" : "Verträge"}
				</span>
			</div>
			{contracts.length ? (
				<>
					<div className="flex flex-col gap-3 sm:flex-row">
						<div className="relative flex-1">
							<Label htmlFor="contract-search" className="sr-only">
								Verträge durchsuchen
							</Label>
							<Search
								aria-hidden="true"
								className="pointer-events-none absolute top-2.5 left-3 size-4 text-muted-foreground"
							/>
							<Input
								id="contract-search"
								type="search"
								className="pl-9"
								placeholder="Vertrag oder Empfänger suchen"
								value={search}
								onChange={(event) => setSearch(event.target.value)}
							/>
						</div>
						<div>
							<Label htmlFor="contract-status" className="sr-only">
								Nach Status filtern
							</Label>
							<NativeSelect
								id="contract-status"
								value={status}
								onChange={(event) => setStatus(event.target.value)}
								className="w-full sm:w-48"
							>
								<option value="all">Alle Status</option>
								<option value="open">Offen</option>
								<option value="completed">Unterzeichnet</option>
								<option value="declined">Abgelehnt</option>
								<option value="expired">Abgelaufen</option>
							</NativeSelect>
						</div>
					</div>
					{visible.length ? (
						<div className="overflow-x-auto">
							<table className="w-full text-left text-sm">
								<thead className="border-y font-mono text-[10px] uppercase tracking-[0.06em] text-muted-foreground">
									<tr>
										<th scope="col" className="pr-5 py-3 font-normal">
											Vertrag
										</th>
										<th scope="col" className="px-4 py-3 font-normal">
											Status
										</th>
										<th scope="col" className="px-4 py-3 font-normal">
											Gesendet
										</th>
										<th scope="col" className="px-5 py-3 sm:px-6">
											<span className="sr-only">Aktionen</span>
										</th>
									</tr>
								</thead>
								<tbody className="divide-y">
									{visible.map((contract) => {
										const state = statuses[contract.status] ?? {
											label: contract.status,
											tone: "neutral" as const,
										};
										return (
											<tr key={contract.id} className="transition-colors hover:bg-muted/20">
												<th scope="row" className="min-w-52 py-4 pr-5 font-normal">
													<div className="flex items-start gap-3">
														<span className="mt-0.5 border p-2">
															<FileText
																aria-hidden="true"
																className="size-4 text-muted-foreground"
															/>
														</span>
														<div className="min-w-0">
															<p className="max-w-sm break-words font-medium">{contract.title}</p>
															<p className="mt-1 max-w-sm break-words text-muted-foreground text-xs">
																{contract.recipients
																	.map((recipient) =>
																		recipient.name
																			? `${recipient.name} · ${recipient.email}`
																			: recipient.email,
																	)
																	.join(", ")}
															</p>
														</div>
													</div>
												</th>
												<td className="px-4 py-4">
													<StatusBadge tone={state.tone}>{state.label}</StatusBadge>
												</td>
												<td className="whitespace-nowrap px-4 py-4 text-muted-foreground text-xs tabular-nums">
													{formatDate(contract.createdAt)}
												</td>
												<td className="px-5 py-4 text-right sm:px-6">
													{contract.status === "completed" ? (
														<Button asChild variant="outline" size="sm">
															<a
																href={`/api/contracts/${encodeURIComponent(contract.id)}/pdf`}
																aria-label={`Unterzeichneten Vertrag ${contract.title} herunterladen`}
															>
																<Download aria-hidden="true" />
																PDF
															</a>
														</Button>
													) : (
														<span className="text-muted-foreground text-xs">–</span>
													)}
												</td>
											</tr>
										);
									})}
								</tbody>
							</table>
						</div>
					) : (
						<EmptyState
							title="Kein passender Vertrag."
							description="Passe deine Suche oder den Statusfilter an."
							action={
								<Button
									variant="outline"
									onClick={() => {
										setSearch("");
										setStatus("all");
									}}
								>
									Filter zurücksetzen
								</Button>
							}
						/>
					)}
				</>
			) : (
				<EmptyState
					icon={FileText}
					title="Der nächste Abschluss beginnt hier."
					description="Versende deinen ersten Vertrag. Den Fortschritt bis zur Unterschrift siehst du anschließend an dieser Stelle."
					action={<Button onClick={onNew}>Ersten Vertrag versenden</Button>}
				/>
			)}
		</Panel>
	);
}
