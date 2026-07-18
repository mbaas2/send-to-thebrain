import { useCallback, useEffect, useState, type KeyboardEvent } from "react";
import { TheBrainLocalClient } from "../api/TheBrainLocalClient";
import {
	TheBrainError,
	NoBrainOpenError,
	NotRunningError,
	InvalidKeyError,
} from "../api/errors";
import { Alert } from "../components/Alert";
import { Button } from "../components/Button";
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from "../components/Card";
import { Input } from "../components/Input";
import { Logo } from "../components/Logo";
import { Spinner } from "../components/Spinner";
import { tabs, runtime, type ActiveTab } from "../lib/browser";
import { DEFAULT_ENDPOINT, isValidEndpoint } from "../lib/endpoint";
import {
	buildCandidates,
	discoverEndpoint,
	portFromEndpoint,
} from "../lib/portDiscovery";
import { sendToBrain, type SendOutcome } from "../lib/sendToBrain";
import { stripUnreadCountPrefix } from "../lib/titleSplit";
import type { Brain, Thought, ThoughtReference } from "../api/types";
import {
	AUTO_PROCEED_MS,
	getSettings,
	pushRecentPort,
	updateSettings,
	type SendMode,
	type Settings,
} from "../lib/settings";
import { hasQueryOrHash, isTrimException, stripQueryAndHash } from "../lib/urlTrim";

interface ActiveThought {
	id: string;
	name: string;
	brainName: string | null;
}

interface ThoughtTarget extends ThoughtReference {
	source: "active" | "pin";
}

const AUTO_CLOSE_MS = 3000;

type ViewState =
	| { kind: "loading" }
	| { kind: "probing" }
	| { kind: "setup" }
	| { kind: "ready" }
	| { kind: "sending" }
	| { kind: "success"; outcome: SendOutcome; client: TheBrainLocalClient }
	| { kind: "error"; message: string; recoverable: boolean };

export function PopupApp() {
	const [settings, setSettings] = useState<Settings | null>(null);
	const [tab, setTab] = useState<ActiveTab | null>(null);
	const [activeThought, setActiveThought] = useState<ActiveThought | null>(null);
	const [view, setView] = useState<ViewState>({ kind: "loading" });
	const [autoProceedActive, setAutoProceedActive] = useState(false);
	const [successAutoCloseActive, setSuccessAutoCloseActive] = useState(true);

	const [brains, setBrains] = useState<Brain[] | null>(null);
	const [selectedBrainId, setSelectedBrainId] = useState<string>("");
	const [types, setTypes] = useState<Thought[]>([]);
	const [tags, setTags] = useState<Thought[]>([]);
	const [selectedTypeId, setSelectedTypeId] = useState<string | null>(null);
	const [newTypeName, setNewTypeName] = useState<string>("");
	const [selectedTagIds, setSelectedTagIds] = useState<string[]>([]);
	const [newTagNames, setNewTagNames] = useState<string[]>([]);
	const [isLoadingMetadata, setIsLoadingMetadata] = useState<boolean>(false);

	const [thoughtTargets, setThoughtTargets] = useState<ThoughtTarget[]>([]);
	const [selectedTargetIndex, setSelectedTargetIndex] = useState<number>(0);

	const loadBrainMetadata = useCallback(async (
		client: TheBrainLocalClient,
		brainId: string,
		appState: any,
		allBrains: Brain[]
	): Promise<ThoughtTarget[]> => {
		setIsLoadingMetadata(true);
		let targetList: ThoughtTarget[] = [];
		try {
			let parentId = "";
			let parentName = "";
			
			const matchingTab = appState?.tabs?.find((t: any) => t.brainId === brainId);
			if (matchingTab && matchingTab.activeThoughtId) {
				parentId = matchingTab.activeThoughtId;
				parentName = matchingTab.activeThoughtName ?? "active thought";
			} else {
				const brainInfo = allBrains.find((b) => b.id === brainId);
				if (brainInfo) {
					parentId = brainInfo.homeThoughtId;
					parentName = "Home";
					try {
						const homeThought = await client.getThought(brainId, brainInfo.homeThoughtId);
						parentName = homeThought.name;
					} catch {
						// ignore
					}
				}
			}

			const brainInfo = allBrains.find((b) => b.id === brainId);
			setActiveThought({
				id: parentId,
				name: parentName,
				brainName: brainInfo ? brainInfo.name : null,
			});

			if (parentId) {
				targetList.push({
					id: parentId,
					name: parentName,
					source: "active",
				});
			}

			try {
				const pins = await client.getPinnedThoughts(brainId);
				const pinTargets = pins
					.filter((pin) => pin.id !== parentId)
					.map((pin): ThoughtTarget => ({
						id: pin.id,
						name: pin.name || "unnamed thought",
						source: "pin",
					}));
				targetList = [...targetList, ...pinTargets];
			} catch (err) {
				console.warn("Failed to fetch pinned thoughts:", err);
			}

			setThoughtTargets(targetList);

			const [fetchedTypes, fetchedTags] = await Promise.all([
				client.getThoughtTypes(brainId),
				client.getThoughtTags(brainId),
			]);

			setTypes(fetchedTypes);
			setTags(fetchedTags);

			setSelectedTypeId(null);
			setNewTypeName("");
			setSelectedTagIds([]);
			setNewTagNames([]);
		} catch (err) {
			console.error("Failed to load brain metadata:", err);
		} finally {
			setIsLoadingMetadata(false);
		}
		return targetList;
	}, []);

	const probeConnection = useCallback(async (s: Settings) => {
		setView({ kind: "probing" });
		let effective = s;
		let client = new TheBrainLocalClient({
			apiKey: s.apiKey,
			endpoint: s.endpoint,
		});
		try {
			let state;
			try {
				state = await client.getAppState();
			} catch(error) {
				if(!(error instanceof NotRunningError)) throw error;
				const rotated = await tryDiscoverNewPort(s);
				if(!rotated) throw error;
				effective = rotated.settings;
				client = rotated.client;
				setSettings(rotated.settings);
				state = await client.getAppState();
			}
			if(!state.currentBrainId || !state.activeThoughtId) {
				throw new NoBrainOpenError();
			}
			await rememberWorkingPort(effective, client.getBaseUrl());
			
			const allBrains = await client.getBrains();
			setBrains(allBrains);

			let targetBrainId = effective.defaultBrainId;
			if (!targetBrainId || !allBrains.some((b) => b.id === targetBrainId)) {
				targetBrainId = state.currentBrainId;
			}
			setSelectedBrainId(targetBrainId);

			const targets = await loadBrainMetadata(client, targetBrainId, state, allBrains);
			setSelectedTargetIndex(
				clampThoughtTargetIndex(effective.thoughtTargetIndex, targets),
			);

			setView({ kind: "ready" });
		} catch(error) {
			setActiveThought(null);
			setThoughtTargets([]);
			setSelectedTargetIndex(0);
			const message =
				error instanceof NotRunningError
					? "TheBrain isn't reachable on any known port. Open the desktop app, copy the Local API URL into Settings, then try again."
					: error instanceof TheBrainError
						? error.message
						: error instanceof Error
							? error.message
							: "Could not reach TheBrain.";
			setView({ kind: "error", message, recoverable: true });
		}
	}, [loadBrainMetadata]);

	useEffect(() => {
		let cancelled = false;
		(async () => {
			const s = await getSettings();
			if(cancelled) return;
			setSettings(s);
			if(!s.apiKey) {
				setView({ kind: "setup" });
				return;
			}
			const active = await tabs.getActive();
			if(cancelled) return;
			if(!active) {
				setView({
					kind: "error",
					message: "No active page to save.",
					recoverable: false,
				});
				return;
			}
			setTab(active);
			await probeConnection(s);
		})();
		return () => {
			cancelled = true;
		};
	}, [probeConnection]);

	const handleBrainChange = useCallback(async (brainId: string) => {
		if (!settings || !brains) return;
		setSelectedBrainId(brainId);
		await updateSettings({ defaultBrainId: brainId, thoughtTargetIndex: 0 });
		setSettings((prev) =>
			prev
				? { ...prev, defaultBrainId: brainId, thoughtTargetIndex: 0 }
				: prev,
		);
		setSelectedTargetIndex(0);

		const client = new TheBrainLocalClient({
			apiKey: settings.apiKey,
			endpoint: settings.endpoint,
		});
		try {
			const state = await client.getAppState();
			await loadBrainMetadata(client, brainId, state, brains);
		} catch (err) {
			console.error("Failed to update brain metadata on change:", err);
		}
	}, [settings, brains, loadBrainMetadata]);

	const handleTargetChange = useCallback(async (thoughtTargetIndex: number) => {
		await updateSettings({ thoughtTargetIndex });
		setSettings((prev) => (prev ? { ...prev, thoughtTargetIndex } : prev));
		setSelectedTargetIndex(thoughtTargetIndex);
	}, []);

	const handleSend = useCallback(async () => {
		if(!tab || !settings || !activeThought || !selectedBrainId) return;
		const targetThought = thoughtTargets[selectedTargetIndex];
		const parentId = targetThought ? targetThought.id : activeThought.id;
		
		setView({ kind: "sending" });
		const client = new TheBrainLocalClient({
			apiKey: settings.apiKey,
			endpoint: settings.endpoint,
		});
		const trimAllowed =
			settings.trimQueryParams &&
			!isTrimException(tab.url, settings.trimQueryParamsExceptions);
		const effectiveUrl = trimAllowed ? stripQueryAndHash(tab.url) : tab.url;
		try {
			const outcome = await sendToBrain({
				client,
				tabTitle: tab.title,
				tabUrl: effectiveUrl,
				mode: settings.mode,
				activateAfterSend: settings.activateAfterSend,
				targetBrainId: selectedBrainId,
				targetParentThoughtId: parentId,
				typeId: selectedTypeId,
				newTypeName: newTypeName,
				tagIds: selectedTagIds,
				newTagNames: newTagNames,
			});
			setView({ kind: "success", outcome, client });
		} catch(error) {
			const message =
				error instanceof TheBrainError
					? error.message
					: error instanceof Error
						? error.message
						: "Something went wrong.";
			setView({ kind: "error", message, recoverable: true });
		}
	}, [
		tab,
		settings,
		activeThought,
		selectedBrainId,
		thoughtTargets,
		selectedTargetIndex,
		selectedTypeId,
		newTypeName,
		selectedTagIds,
		newTagNames,
	]);

	// Arm the countdown when we first reach the ready view, if the user
	// opted in. Cancelling (user interaction) sets autoProceedActive to
	// false; transitioning away from ready unmounts the firing effect.
	useEffect(() => {
		if(view.kind === "ready" && settings?.autoProceed) {
			setAutoProceedActive(true);
		}
	}, [view.kind, settings?.autoProceed]);

	useEffect(() => {
		if(view.kind !== "ready" || !autoProceedActive) return;
		const timer = window.setTimeout(() => {
			setAutoProceedActive(false);
			handleSend();
		}, AUTO_PROCEED_MS);
		const cancel = () => setAutoProceedActive(false);
		// Capture phase so a click on Send isn't swallowed — the button's own
		// onClick still runs, but the countdown-driven send is suppressed.
		window.addEventListener("pointerdown", cancel, true);
		window.addEventListener("keydown", cancel, true);
		return () => {
			window.clearTimeout(timer);
			window.removeEventListener("pointerdown", cancel, true);
			window.removeEventListener("keydown", cancel, true);
		};
	}, [view.kind, autoProceedActive, handleSend]);

	const handleTrimChange = useCallback(
		async (trimQueryParams: boolean) => {
			await updateSettings({ trimQueryParams });
			setSettings((prev) => (prev ? { ...prev, trimQueryParams } : prev));
		},
		[],
	);

	const handleModeChange = useCallback(async (mode: SendMode) => {
		await updateSettings({ mode });
		setSettings((prev) => (prev ? { ...prev, mode } : prev));
	}, []);

	// Arm the auto-close every time we enter the success view.
	useEffect(() => {
		if(view.kind === "success") {
			setSuccessAutoCloseActive(true);
		}
	}, [view.kind]);

	// Auto-dismiss the popup after a successful save so it feels like a
	// one-click action. Any interaction (click, key press) inside the popup
	// cancels the auto-close so the user can read the message or click
	// "Open in TheBrain" without fighting the timer.
	useEffect(() => {
		if(view.kind !== "success" || !successAutoCloseActive) return;
		const id = window.setTimeout(() => window.close(), AUTO_CLOSE_MS);
		const cancel = () => setSuccessAutoCloseActive(false);
		window.addEventListener("pointerdown", cancel, true);
		window.addEventListener("keydown", cancel, true);
		return () => {
			window.clearTimeout(id);
			window.removeEventListener("pointerdown", cancel, true);
			window.removeEventListener("keydown", cancel, true);
		};
	}, [view.kind, successAutoCloseActive]);

	const handleSetupComplete = useCallback(async (apiKey: string, endpoint: string) => {
		await updateSettings({ apiKey, endpoint });
		const next = await getSettings();
		setSettings(next);
		const active = await tabs.getActive();
		if(!active) {
			setView({
				kind: "error",
				message: "No active page to save.",
				recoverable: false,
			});
			return;
		}
		setTab(active);
		await probeConnection(next);
	}, [probeConnection]);

	const handleRetry = useCallback(async () => {
		if(!settings) return;
		await probeConnection(settings);
	}, [settings, probeConnection]);

	if(view.kind === "loading" || view.kind === "probing") {
		return (
			<div className="flex flex-col items-center justify-center gap-2 p-8 text-xs text-muted-foreground">
				<Spinner />
				{view.kind === "probing" && <span>Checking connection…</span>}
			</div>
		);
	}

	if(view.kind === "setup") {
		return <SetupView onComplete={handleSetupComplete} />;
	}

	return (
		<div className="flex flex-col gap-3 p-4">
			<Header />
			{view.kind === "ready" && settings && tab && activeThought && brains && (
				<ReadyCard
					tab={tab}
					activeThought={activeThought}
					mode={settings.mode}
					onModeChange={handleModeChange}
					trimQueryParams={settings.trimQueryParams}
					trimExceptions={settings.trimQueryParamsExceptions}
					onTrimChange={handleTrimChange}
					onSend={handleSend}
					autoProceedActive={autoProceedActive}
					brains={brains}
					selectedBrainId={selectedBrainId}
					onBrainChange={handleBrainChange}
					types={types}
					tags={tags}
					selectedTypeId={selectedTypeId}
					onTypeChange={(id, newName) => {
						setSelectedTypeId(id);
						setNewTypeName(newName);
					}}
					newTypeName={newTypeName}
					selectedTagIds={selectedTagIds}
					onSelectedTagIdsChange={setSelectedTagIds}
					newTagNames={newTagNames}
					onNewTagNamesChange={setNewTagNames}
					isLoadingMetadata={isLoadingMetadata}
					thoughtTargets={thoughtTargets}
					selectedTargetIndex={selectedTargetIndex}
					onTargetChange={handleTargetChange}
				/>
			)}
			{view.kind === "sending" && tab && <SendingCard tab={tab} />}
			{view.kind === "success" && (
				<SuccessCard
					outcome={view.outcome}
					onOpen={() =>
						view.client.activateThought(view.outcome.brainId, view.outcome.thoughtId)
					}
					onReset={() => setView({ kind: "ready" })}
					autoCloseActive={successAutoCloseActive}
				/>
			)}
			{view.kind === "error" && (
				<ErrorCard
					message={view.message}
					onRetry={view.recoverable ? handleRetry : undefined}
					onOpenSettings={() => runtime.openOptionsPage()}
				/>
			)}
		</div>
	);
}

// When the saved endpoint goes silent (typical: TheBrain restarted with a
// new ephemeral port), fan out to a handful of likely ports in parallel
// and return a refreshed client + settings if any of them answers. Browser
// extensions can't enumerate listening sockets the way a PowerShell script
// can, so this best-effort probe is the closest analogue.
async function tryDiscoverNewPort(s: Settings): Promise<{
	client: TheBrainLocalClient;
	settings: Settings;
} | null> {
	const candidates = buildCandidates(s.endpoint, s.recentPorts);
	if(candidates.length === 0) return null;
	const result = await discoverEndpoint({
		apiKey: s.apiKey,
		candidates,
	});
	if(result.winner === null) {
		// If every candidate that answered did so with 401, the port is
		// fine but the saved key is stale — surface that explicitly so the
		// user knows to refresh it instead of chasing port numbers.
		const auth = result.all.find((r) => r.kind === "auth");
		if(auth) {
			throw new InvalidKeyError();
		}
		return null;
	}
	const newEndpoint = result.winner.origin;
	const newRecent = pushRecentPort(s.recentPorts, result.winner.port);
	await updateSettings({ endpoint: newEndpoint, recentPorts: newRecent });
	const next: Settings = { ...s, endpoint: newEndpoint, recentPorts: newRecent };
	const client = new TheBrainLocalClient({
		apiKey: next.apiKey,
		endpoint: next.endpoint,
	});
	return { client, settings: next };
}

// Push the active port to the front of the MRU list whenever a probe
// succeeds. We swallow storage errors silently — failing to update the
// history must never break a working send.
async function rememberWorkingPort(s: Settings, baseUrl: string): Promise<void> {
	const port = portFromEndpoint(baseUrl);
	if(port === null) return;
	if(s.recentPorts[0] === port) return;
	const next = pushRecentPort(s.recentPorts, port);
	try {
		await updateSettings({ recentPorts: next });
	} catch(error) {
		console.warn("[Send to TheBrain] failed to record recent port:", error);
	}
}

function clampThoughtTargetIndex(index: number, list: unknown[]): number {
	if (list.length === 0) return 0;
	if (index < 0) return 0;
	if (index >= list.length) return 0;
	return index;
}

function Header() {
	return (
		<div className="flex items-center gap-2">
			<Logo className="h-6 w-6 text-brand" />
			<span className="text-sm font-semibold">Send to TheBrain</span>
			<button
				type="button"
				className="ml-auto text-xs text-muted-foreground hover:text-foreground"
				onClick={() => runtime.openOptionsPage()}
			>
				Settings
			</button>
			<button
				type="button"
				className="flex h-6 w-6 items-center justify-center rounded-full text-muted-foreground hover:bg-secondary hover:text-foreground"
				onClick={() => window.close()}
				aria-label="Close"
				title="Close"
			>
				<svg
					viewBox="0 0 16 16"
					aria-hidden="true"
					className="h-3.5 w-3.5"
					fill="none"
					stroke="currentColor"
					strokeWidth="2"
					strokeLinecap="round"
				>
					<path d="M3 3 L13 13 M13 3 L3 13" />
				</svg>
			</button>
		</div>
	);
}

function TagsSelector({
	existingTags,
	selectedTagIds,
	onSelectedTagIdsChange,
	newTagNames,
	onNewTagNamesChange,
}: {
	existingTags: Thought[];
	selectedTagIds: string[];
	onSelectedTagIdsChange: (ids: string[]) => void;
	newTagNames: string[];
	onNewTagNamesChange: (names: string[]) => void;
}) {
	const [input, setInput] = useState("");
	const [isFocused, setIsFocused] = useState(false);

	const selectedTags = existingTags.filter((t) => selectedTagIds.includes(t.id));

	const suggestions = existingTags
		.filter(
			(t) =>
				!selectedTagIds.includes(t.id) &&
				(!input.trim() || t.name.toLowerCase().includes(input.toLowerCase().trim())),
		)
		.sort((a, b) => a.name.localeCompare(b.name));

	const showCreateOption =
		input.trim() &&
		!existingTags.some((t) => t.name.toLowerCase() === input.trim().toLowerCase()) &&
		!newTagNames.some((n) => n.toLowerCase() === input.trim().toLowerCase());

	const handleAddTagId = (id: string) => {
		onSelectedTagIdsChange([...selectedTagIds, id]);
		setInput("");
	};

	const handleAddNewTagName = (name: string) => {
		onNewTagNamesChange([...newTagNames, name]);
		setInput("");
	};

	const handleRemoveTagId = (id: string) => {
		onSelectedTagIdsChange(selectedTagIds.filter((x) => x !== id));
	};

	const handleRemoveNewTagName = (name: string) => {
		onNewTagNamesChange(newTagNames.filter((x) => x !== name));
	};

	const handleKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
		if (e.key === "Enter" && input.trim()) {
			e.preventDefault();
			const exactMatch = suggestions.find(
				(t) => t.name.toLowerCase() === input.trim().toLowerCase(),
			);
			if (exactMatch) {
				handleAddTagId(exactMatch.id);
			} else if (showCreateOption) {
				handleAddNewTagName(input.trim());
			} else if (suggestions.length > 0) {
				handleAddTagId(suggestions[0].id);
			}
		}
	};

	return (
		<div className="relative flex flex-col gap-1.5">
			<span className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground">Tags</span>
			<div className="flex flex-wrap gap-1 rounded-md border border-input bg-background p-1.5 min-h-[36px] focus-within:border-brand focus-within:ring-1 focus-within:ring-brand shadow-sm">
				{selectedTags.map((tag) => (
					<span
						key={tag.id}
						className="inline-flex items-center gap-1 rounded bg-secondary px-2 py-0.5 text-xs text-secondary-foreground"
					>
						{tag.name}
						<button
							type="button"
							className="rounded hover:bg-muted p-0.5"
							onClick={() => handleRemoveTagId(tag.id)}
						>
							<svg className="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
								<path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
							</svg>
						</button>
					</span>
				))}
				{newTagNames.map((name) => (
					<span
						key={name}
						className="inline-flex items-center gap-1 rounded bg-brand/10 border border-brand/20 px-2 py-0.5 text-xs text-brand"
					>
						{name} (new)
						<button
							type="button"
							className="rounded hover:bg-brand/20 p-0.5"
							onClick={() => handleRemoveNewTagName(name)}
						>
							<svg className="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
								<path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
							</svg>
						</button>
					</span>
				))}
				<input
					type="text"
					className="flex-1 bg-transparent px-1 py-0.5 text-xs focus:outline-none min-w-[60px]"
					placeholder={selectedTagIds.length === 0 && newTagNames.length === 0 ? "Add tag..." : ""}
					value={input}
					onFocus={() => setIsFocused(true)}
					onBlur={() => setTimeout(() => setIsFocused(false), 200)}
					onKeyDown={handleKeyDown}
					onChange={(e) => setInput(e.target.value)}
				/>
			</div>

			{isFocused && (input.trim() !== "" || suggestions.length > 0) && (
				<div
					className="absolute z-50 mt-1 max-h-40 w-full overflow-auto rounded-md border border-border shadow-md animate-fade-in p-1 text-xs top-full"
					style={{ backgroundColor: "var(--color-card)", color: "var(--color-card-foreground)" }}
				>
					{suggestions.map((s) => (
						<button
							key={s.id}
							type="button"
							className="w-full text-left rounded px-2 py-1.5 hover:bg-secondary hover:text-secondary-foreground"
							onClick={() => handleAddTagId(s.id)}
						>
							{s.name}
						</button>
					))}
					{showCreateOption && (
						<button
							type="button"
							className="w-full text-left rounded px-2 py-1.5 font-medium text-brand hover:bg-secondary hover:text-secondary-foreground"
							onClick={() => handleAddNewTagName(input.trim())}
						>
							+ Add brand new tag: "{input.trim()}"
						</button>
					)}
					{suggestions.length === 0 && !showCreateOption && (
						<div className="px-2 py-1.5 text-muted-foreground text-center">No matches</div>
					)}
				</div>
			)}
		</div>
	);
}

function TypeSelector({
	existingTypes,
	selectedTypeId,
	newTypeName,
	onChange,
}: {
	existingTypes: Thought[];
	selectedTypeId: string | null;
	newTypeName: string;
	onChange: (id: string | null, newName: string) => void;
}) {
	const [input, setInput] = useState("");
	const [isFocused, setIsFocused] = useState(false);

	const selectedType = selectedTypeId && selectedTypeId !== "new"
		? existingTypes.find((t) => t.id === selectedTypeId)
		: null;

	const suggestions = existingTypes
		.filter(
			(t) =>
				(!input.trim() || t.name.toLowerCase().includes(input.toLowerCase().trim())),
		)
		.sort((a, b) => a.name.localeCompare(b.name));

	const showCreateOption =
		input.trim() &&
		!existingTypes.some((t) => t.name.toLowerCase() === input.trim().toLowerCase()) &&
		newTypeName.toLowerCase() !== input.trim().toLowerCase();

	const handleSelectTypeId = (id: string) => {
		onChange(id, "");
		setInput("");
	};

	const handleAddNewTypeName = (name: string) => {
		onChange("new", name);
		setInput("");
	};

	const handleClear = () => {
		onChange(null, "");
		setInput("");
	};

	const handleKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
		if (e.key === "Enter" && input.trim()) {
			e.preventDefault();
			const exactMatch = suggestions.find(
				(t) => t.name.toLowerCase() === input.trim().toLowerCase(),
			);
			if (exactMatch) {
				handleSelectTypeId(exactMatch.id);
			} else if (showCreateOption) {
				handleAddNewTypeName(input.trim());
			} else if (suggestions.length > 0) {
				handleSelectTypeId(suggestions[0].id);
			}
		}
	};

	return (
		<div className="relative flex flex-col gap-1.5">
			<span className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground">Thought Type</span>
			<div className="flex items-center gap-1 rounded-md border border-input bg-background p-1.5 min-h-[36px] focus-within:border-brand focus-within:ring-1 focus-within:ring-brand shadow-sm">
				{selectedType && (
					<span className="inline-flex items-center gap-1 rounded bg-secondary px-2 py-0.5 text-xs text-secondary-foreground">
						{selectedType.name}
						<button
							type="button"
							className="rounded hover:bg-muted p-0.5"
							onClick={handleClear}
						>
							<svg className="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
								<path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
							</svg>
						</button>
					</span>
				)}
				{selectedTypeId === "new" && newTypeName && (
					<span className="inline-flex items-center gap-1 rounded bg-brand/10 border border-brand/20 px-2 py-0.5 text-xs text-brand">
						{newTypeName} (new)
						<button
							type="button"
							className="rounded hover:bg-brand/20 p-0.5"
							onClick={handleClear}
						>
							<svg className="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
								<path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
							</svg>
						</button>
					</span>
				)}
				{!selectedTypeId && (
					<input
						type="text"
						className="flex-1 bg-transparent px-1 py-0.5 text-xs focus:outline-none min-w-[60px]"
						placeholder="Search or create type..."
						value={input}
						onFocus={() => setIsFocused(true)}
						onBlur={() => setTimeout(() => setIsFocused(false), 200)}
						onKeyDown={handleKeyDown}
						onChange={(e) => setInput(e.target.value)}
					/>
				)}
			</div>

			{isFocused && !selectedTypeId && (input.trim() !== "" || suggestions.length > 0) && (
				<div
					className="absolute z-50 mt-1 max-h-40 w-full overflow-auto rounded-md border border-border shadow-md p-1 text-xs top-full"
					style={{ backgroundColor: "var(--color-card)", color: "var(--color-card-foreground)" }}
				>
					{suggestions.map((s) => (
						<button
							key={s.id}
							type="button"
							className="w-full text-left rounded px-2 py-1.5 hover:bg-secondary hover:text-secondary-foreground"
							onClick={() => handleSelectTypeId(s.id)}
						>
							{s.name}
						</button>
					))}
					{showCreateOption && (
						<button
							type="button"
							className="w-full text-left rounded px-2 py-1.5 font-medium text-brand hover:bg-secondary hover:text-secondary-foreground"
							onClick={() => handleAddNewTypeName(input.trim())}
						>
							+ Add brand new type: "{input.trim()}"
						</button>
					)}
					{suggestions.length === 0 && !showCreateOption && (
						<div className="px-2 py-1.5 text-muted-foreground text-center">No matches</div>
					)}
				</div>
			)}
		</div>
	);
}

function ReadyCard({
	tab,
	activeThought,
	mode,
	onModeChange,
	trimQueryParams,
	trimExceptions,
	onTrimChange,
	onSend,
	autoProceedActive,
	brains,
	selectedBrainId,
	onBrainChange,
	types,
	tags,
	selectedTypeId,
	onTypeChange,
	newTypeName,
	selectedTagIds,
	onSelectedTagIdsChange,
	newTagNames,
	onNewTagNamesChange,
	isLoadingMetadata,
	thoughtTargets,
	selectedTargetIndex,
	onTargetChange,
}: {
	tab: ActiveTab;
	activeThought: ActiveThought;
	mode: SendMode;
	onModeChange: (mode: SendMode) => void;
	trimQueryParams: boolean;
	trimExceptions: string[];
	onTrimChange: (value: boolean) => void;
	onSend: () => void;
	autoProceedActive: boolean;
	brains: Brain[];
	selectedBrainId: string;
	onBrainChange: (id: string) => void;
	types: Thought[];
	tags: Thought[];
	selectedTypeId: string | null;
	onTypeChange: (id: string | null, newName: string) => void;
	newTypeName: string;
	selectedTagIds: string[];
	onSelectedTagIdsChange: (ids: string[]) => void;
	newTagNames: string[];
	onNewTagNamesChange: (names: string[]) => void;
	isLoadingMetadata: boolean;
	thoughtTargets: ThoughtTarget[];
	selectedTargetIndex: number;
	onTargetChange: (thoughtTargetIndex: number) => void;
}) {
	const [barWidth, setBarWidth] = useState("100%");
	useEffect(() => {
		if(!autoProceedActive) {
			setBarWidth("100%");
			return;
		}
		setBarWidth("100%");
		const id = requestAnimationFrame(() => setBarWidth("0%"));
		return () => cancelAnimationFrame(id);
	}, [autoProceedActive]);
	const isException = isTrimException(tab.url, trimExceptions);
	const showTrimOption = hasQueryOrHash(tab.url) && !isException;
	const previewUrl = showTrimOption && trimQueryParams ? stripQueryAndHash(tab.url) : tab.url;
	const selectedTarget =
		thoughtTargets[clampThoughtTargetIndex(selectedTargetIndex, thoughtTargets)] ?? {
			id: activeThought.id,
			name: activeThought.name,
			source: "active" as const,
		};
	const sendLabel =
		mode === "createChild"
			? `Create child of "${selectedTarget.name}"`
			: `Attach to "${selectedTarget.name}"`;

	return (
		<Card>
			<CardHeader>
				<CardTitle className="text-base">{stripUnreadCountPrefix(tab.title) || tab.url}</CardTitle>
				<p className="break-all text-xs text-muted-foreground">{previewUrl}</p>
			</CardHeader>
			<CardContent className="flex flex-col gap-3.5 pt-0">
				<div className="flex flex-col gap-1.5">
					<span className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground">Target Brain</span>
					<select
						className="w-full rounded-md border border-input bg-background px-2.5 py-1.5 text-xs text-foreground shadow-sm transition-colors focus:border-brand focus:outline-none focus:ring-1 focus:ring-brand"
						value={selectedBrainId}
						onChange={(e) => onBrainChange(e.target.value)}
					>
						{brains.map((b) => (
							<option key={b.id} value={b.id}>
								{b.name}
							</option>
						))}
					</select>
				</div>

				<div className="flex flex-col gap-1.5">
					<span className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground">Relate to (Parent)</span>
					<select
						className="w-full rounded-md border border-input bg-background px-2.5 py-1.5 text-xs text-foreground shadow-sm transition-colors focus:border-brand focus:outline-none focus:ring-1 focus:ring-brand"
						value={selectedTargetIndex}
						onChange={(e) => onTargetChange(Number(e.target.value))}
					>
						{thoughtTargets.map((target, index) => (
							<option key={`${target.source}:${target.id}`} value={index}>
								{target.source === "active"
									? `Active: "${target.name}"`
									: `Pin: "${target.name}"`}
							</option>
						))}
					</select>
				</div>

				<ModeToggle mode={mode} onChange={onModeChange} />

				{isLoadingMetadata ? (
					<div className="flex items-center justify-center gap-2 py-6 text-xs text-muted-foreground animate-pulse">
						<Spinner />
						<span>Loading brain data...</span>
					</div>
				) : (
					mode === "createChild" && (
						<div className="flex flex-col gap-3.5 border-t border-border/40 pt-3.5 animate-fade-in">
							<TypeSelector
								existingTypes={types}
								selectedTypeId={selectedTypeId}
								newTypeName={newTypeName}
								onChange={onTypeChange}
							/>

							<TagsSelector
								existingTags={tags}
								selectedTagIds={selectedTagIds}
								onSelectedTagIdsChange={onSelectedTagIdsChange}
								newTagNames={newTagNames}
								onNewTagNamesChange={onNewTagNamesChange}
							/>
						</div>
					)
				)}

				{showTrimOption && (
					<label className="flex items-center gap-2 text-xs text-muted-foreground cursor-pointer hover:text-foreground transition-colors py-1">
						<input
							type="checkbox"
							className="h-4 w-4 rounded border-input text-brand accent-brand cursor-pointer focus:ring-0 focus:ring-offset-0"
							checked={trimQueryParams}
							onChange={(e) => onTrimChange(e.target.checked)}
						/>
						<span>Remove query parameters &amp; fragment</span>
					</label>
				)}
			</CardContent>
			<CardFooter className="flex-col items-stretch gap-2">
				<Button onClick={onSend} className="w-full min-w-0 font-medium py-2 bg-brand text-brand-foreground hover:bg-brand/90 transition-all rounded shadow-md hover:shadow-lg" title={sendLabel} disabled={isLoadingMetadata}>
					<span className="min-w-0 truncate">{sendLabel}</span>
				</Button>
				{autoProceedActive && (
					<>
						<p className="text-center text-xs text-muted-foreground">
							Sending automatically — click anywhere to cancel.
						</p>
						<div
							className="h-1 w-full overflow-hidden rounded-full bg-muted"
							aria-hidden
						>
							<div
								className="h-full bg-brand ease-linear"
								style={{
									width: barWidth,
									transitionProperty: "width",
									transitionDuration: `${AUTO_PROCEED_MS}ms`,
								}}
							/>
						</div>
					</>
				)}
			</CardFooter>
		</Card>
	);
}

function ModeToggle({ mode, onChange }: { mode: SendMode; onChange: (mode: SendMode) => void }) {
	const options: { value: SendMode; label: string }[] = [
		{ value: "createChild", label: "Create child" },
		{ value: "attachToActive", label: "Attach" },
	];
	return (
		<div
			className="inline-flex w-full items-center gap-1 rounded-full border border-border bg-background p-1"
			role="radiogroup"
			aria-label="Send mode"
		>
			{options.map((opt) => {
				const active = mode === opt.value;
				return (
					<button
						key={opt.value}
						type="button"
						role="radio"
						aria-checked={active}
						onClick={() => onChange(opt.value)}
						className={
							"flex-1 rounded-full px-3 py-1 text-xs font-medium transition-colors " +
							(active
								? "bg-brand text-brand-foreground shadow-sm"
								: "text-muted-foreground hover:text-foreground")
						}
					>
						{opt.label}
					</button>
				);
			})}
		</div>
	);
}

function SendingCard({ tab }: { tab: ActiveTab }) {
	return (
		<Card>
			<CardHeader>
				<CardTitle className="text-base">{stripUnreadCountPrefix(tab.title) || tab.url}</CardTitle>
			</CardHeader>
			<CardContent className="flex items-center gap-2 text-sm text-muted-foreground">
				<Spinner />
				Sending...
			</CardContent>
		</Card>
	);
}

function SuccessCard({
	outcome,
	onOpen,
	onReset: _onReset,
	autoCloseActive,
}: {
	outcome: SendOutcome;
	onOpen: () => void;
	onReset: () => void;
	autoCloseActive: boolean;
}) {
	const title =
		outcome.kind === "created"
			? "Added to your brain"
			: outcome.kind === "attached"
				? "Attached to the active thought"
				: "Already in your brain";
	const message =
		outcome.kind === "created"
			? `Created "${outcome.thoughtName}"${"label" in outcome && outcome.label ? ` (${outcome.label})` : ""}.`
			: outcome.kind === "attached"
				? `Attached to "${outcome.thoughtName}".`
				: `Found existing thought "${outcome.thoughtName}".`;
	// Two-pass render so the bar animates: start at 100%, then on the next
	// paint flip to 0% and let the CSS transition run over AUTO_CLOSE_MS.
	// If the user cancels the auto-close, hide the bar entirely.
	const [barWidth, setBarWidth] = useState("100%");
	useEffect(() => {
		if(!autoCloseActive) return;
		const id = requestAnimationFrame(() => setBarWidth("0%"));
		return () => cancelAnimationFrame(id);
	}, [autoCloseActive]);
	return (
		<>
			<Alert variant="success" title={title}>
				{message}
			</Alert>
			<Button variant="secondary" onClick={onOpen}>
				Open in TheBrain
			</Button>
			{autoCloseActive && (
				<div
					className="h-1 w-full overflow-hidden rounded-full bg-muted"
					aria-hidden
					title="Closing shortly"
				>
					<div
						className="h-full bg-success ease-linear"
						style={{
							width: barWidth,
							transitionProperty: "width",
							transitionDuration: `${AUTO_CLOSE_MS}ms`,
						}}
					/>
				</div>
			)}
		</>
	);
}

function ErrorCard({
	message,
	onRetry,
	onOpenSettings,
}: {
	message: string;
	onRetry?: () => void;
	onOpenSettings: () => void;
}) {
	return (
		<>
			<Alert variant="error" title="Couldn't save">
				{message}
			</Alert>
			<div className="flex gap-2">
				{onRetry && (
					<Button variant="secondary" onClick={onRetry} className="flex-1">
						Try again
					</Button>
				)}
				<Button variant="ghost" onClick={onOpenSettings} className="flex-1">
					Open settings
				</Button>
			</div>
		</>
	);
}

interface SetupViewProps {
	onComplete: (apiKey: string, endpoint: string) => void;
}

function SetupView({ onComplete }: SetupViewProps) {
	const [apiKey, setApiKey] = useState("");
	const [endpoint, setEndpoint] = useState(DEFAULT_ENDPOINT);
	const [testing, setTesting] = useState(false);
	const [result, setResult] = useState<
		| { kind: "idle" }
		| { kind: "success"; brains: number }
		| { kind: "error"; message: string }
	>({ kind: "idle" });

	const keyValid = apiKey.trim().length > 0;
	const endpointValid = isValidEndpoint(endpoint);
	const canSubmit = keyValid && endpointValid;

	const handleTest = async () => {
		setTesting(true);
		setResult({ kind: "idle" });
		try {
			const client = new TheBrainLocalClient({
				apiKey: apiKey.trim(),
				endpoint: endpoint.trim(),
			});
			const brains = await client.getBrains();
			setResult({ kind: "success", brains: brains.length });
		} catch(error) {
			const message =
				error instanceof TheBrainError
					? error.message
					: error instanceof Error
						? error.message
						: "Could not connect.";
			setResult({ kind: "error", message });
		} finally {
			setTesting(false);
		}
	};

	return (
		<div className="flex flex-col gap-3 p-4">
			<div className="flex items-center gap-2">
				<Logo className="h-7 w-7 text-brand" />
				<span className="text-base font-semibold">Connect to TheBrain</span>
			</div>
			<Card>
				<CardContent className="flex flex-col gap-3 pt-4 text-sm">
					<div>
						<p className="mb-1 font-medium">To connect:</p>
						<ol className="list-decimal pl-5 text-muted-foreground">
							<li>
								Make sure{" "}
								<a
									href="https://thebrain.com/download"
									target="_blank"
									rel="noreferrer"
									className="text-brand underline underline-offset-2 hover:no-underline"
								>
									TheBrain's desktop app
								</a>{" "}
								is installed and running.
							</li>
							<li>Go to Settings &rarr; User &rarr; Local API.</li>
							<li>Copy the API Endpoint and API Key, and paste them below.</li>
						</ol>
					</div>
					<label className="flex flex-col gap-1.5">
						<span className="text-xs font-medium">API endpoint</span>
						<Input
							type="text"
							autoComplete="off"
							placeholder="http://localhost:8001/api/"
							value={endpoint}
							onChange={(e) => setEndpoint(e.target.value)}
						/>
					</label>
					<label className="flex flex-col gap-1.5">
						<span className="text-xs font-medium">API key</span>
						<Input
							type="password"
							autoComplete="off"
							placeholder="Paste your key"
							value={apiKey}
							onChange={(e) => setApiKey(e.target.value)}
						/>
					</label>
					{result.kind === "success" && (
						<Alert variant="success" title="Connected">
							Found {result.brains} {result.brains === 1 ? "brain" : "brains"}.
						</Alert>
					)}
					{result.kind === "error" && (
						<Alert variant="error" title="Couldn't connect">
							{result.message}
						</Alert>
					)}
				</CardContent>
				<CardFooter className="flex-col gap-2">
					<Button
						variant="secondary"
						onClick={handleTest}
						disabled={!canSubmit || testing}
						className="w-full"
					>
						{testing ? <Spinner /> : "Test connection"}
					</Button>
					<Button
						onClick={() => onComplete(apiKey.trim(), endpoint.trim())}
						disabled={!canSubmit}
						className="w-full"
					>
						Save and continue
					</Button>
				</CardFooter>
			</Card>
			<p className="text-xs text-muted-foreground">
				You can change these anytime in the options page.
			</p>
		</div>
	);
}
