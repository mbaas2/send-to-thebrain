// Orchestrates the "save this page" workflow end-to-end. Split out of the
// popup component so the logic is testable in isolation and reusable if we
// later add a keyboard-shortcut or context-menu entry point.

import { TheBrainLocalClient } from "../api/TheBrainLocalClient";
import {
	NoBrainOpenError,
	ReadOnlyBrainError,
	ApiError,
	TheBrainError,
} from "../api/errors";
import { LinkRelation, ThoughtKind } from "../api/types";
import type { SendMode } from "./settings";
import { splitTitle } from "./titleSplit";

export interface SendInput {
	client: TheBrainLocalClient;
	tabTitle: string;
	tabUrl: string;
	mode: SendMode;
	activateAfterSend: boolean;
	targetBrainId?: string;
	targetParentThoughtId?: string;
	typeId?: string | null;
	newTypeName?: string | null;
	tagIds?: string[];
	newTagNames?: string[];
}

export type SendOutcome =
	| {
			kind: "created";
			brainId: string;
			thoughtId: string;
			thoughtName: string;
			label: string;
	  }
	| {
			kind: "attached";
			brainId: string;
			thoughtId: string;
			thoughtName: string;
	  }
	| {
			kind: "alreadyExists";
			brainId: string;
			thoughtId: string;
			thoughtName: string;
	  };

export async function sendToBrain(input: SendInput): Promise<SendOutcome> {
	const {
		client,
		tabTitle,
		tabUrl,
		mode,
		activateAfterSend,
		targetBrainId,
		targetParentThoughtId,
		typeId,
		newTypeName,
		tagIds,
		newTagNames,
	} = input;

	let brainId = targetBrainId;
	let parentThoughtId = targetParentThoughtId;
	let parentThoughtName = "active thought";

	if (!brainId || !parentThoughtId) {
		const state = await client.getAppState();
		if(!state.currentBrainId || !state.activeThoughtId) {
			throw new NoBrainOpenError();
		}
		brainId = brainId || state.currentBrainId;
		parentThoughtId = parentThoughtId || state.activeThoughtId;
		parentThoughtName = state.activeThoughtName ?? "active thought";
	} else if (!parentThoughtId) {
		// If we only have brainId, we'll need to fetch the home thought to use as parent
		const brains = await client.getBrains();
		const targetBrain = brains.find((b) => b.id === brainId);
		if (targetBrain) {
			parentThoughtId = targetBrain.homeThoughtId;
			parentThoughtName = "Home";
		} else {
			throw new Error("Target brain not found.");
		}
	}

	const existing = await findExistingThoughtWithUrl(client, brainId, tabUrl);
	if(existing) {
		if(activateAfterSend) {
			await client.activateThought(brainId, existing.thoughtId);
		}
		return {
			kind: "alreadyExists",
			brainId: brainId,
			thoughtId: existing.thoughtId,
			thoughtName: existing.thoughtName,
		};
	}

	const { name, label } = splitTitle(tabTitle);
	const effectiveName = name.length > 0 ? name : tabUrl;
	const attachmentName = tabTitle.trim().length > 0 ? tabTitle.trim() : tabUrl;

	try {
		// 1. Resolve / create Type if needed
		let effectiveTypeId = typeId || null;
		if (!effectiveTypeId && newTypeName && newTypeName.trim().length > 0) {
			const existingTypes = await client.getThoughtTypes(brainId);
			const found = existingTypes.find(
				(t) => t.name.toLowerCase() === newTypeName.trim().toLowerCase(),
			);
			if (found) {
				effectiveTypeId = found.id;
			} else {
				const createdType = await client.createThought(brainId, {
					name: newTypeName.trim(),
					kind: ThoughtKind.Type,
					acType: 0,
				});
				effectiveTypeId = createdType.id;
			}
		}

		// 2. Resolve / create Tags if needed
		const finalTagIds: string[] = [...(tagIds || [])];
		if (newTagNames && newTagNames.length > 0) {
			const existingTags = await client.getThoughtTags(brainId);
			for (const tagOfNew of newTagNames) {
				const trimmed = tagOfNew.trim();
				if (trimmed.length === 0) continue;
				const found = existingTags.find(
					(t) => t.name.toLowerCase() === trimmed.toLowerCase(),
				);
				if (found) {
					if (!finalTagIds.includes(found.id)) {
						finalTagIds.push(found.id);
					}
				} else {
					const createdTag = await client.createThought(brainId, {
						name: trimmed,
						kind: ThoughtKind.Tag,
						acType: 0,
					});
					finalTagIds.push(createdTag.id);
				}
			}
		}

		if(mode === "createChild") {
			const created = await client.createChildThought(
				brainId,
				parentThoughtId,
				effectiveName,
				label,
				effectiveTypeId,
			);
			await client.attachUrl(
				brainId,
				created.id,
				tabUrl,
				attachmentName,
			);

			// Link the tags
			for (const tagId of finalTagIds) {
				try {
					await client.createLink(brainId, tagId, created.id, LinkRelation.Child);
				} catch (err) {
					console.warn(`[Send to TheBrain] failed to link tag ${tagId}:`, err);
				}
			}

			if(activateAfterSend) {
				await client.activateThought(brainId, created.id);
			}
			return {
				kind: "created",
				brainId: brainId,
				thoughtId: created.id,
				thoughtName: effectiveName,
				label,
			};
		}

		// attachToActive
		await client.attachUrl(
			brainId,
			parentThoughtId,
			tabUrl,
			attachmentName,
		);
		// Also link tags in attachToActive just in case the user specified them
		for (const tagId of finalTagIds) {
			try {
				await client.createLink(brainId, tagId, parentThoughtId, LinkRelation.Child);
			} catch (err) {
				console.warn(`[Send to TheBrain] failed to link tag ${tagId}:`, err);
			}
		}

		return {
			kind: "attached",
			brainId: brainId,
			thoughtId: parentThoughtId,
			thoughtName: parentThoughtName,
		};
	} catch(error) {
		// Auth and user-mismatch have already been filtered out in the client.
		// A 400/403 here means the target brain rejected the write.
		if(error instanceof ApiError && (error.status === 400 || error.status === 403)) {
			throw new ReadOnlyBrainError();
		}
		throw error;
	}
}

interface ExistingHit {
	thoughtId: string;
	thoughtName: string;
}

async function findExistingThoughtWithUrl(
	client: TheBrainLocalClient,
	brainId: string,
	url: string,
): Promise<ExistingHit | null> {
	if(!brainId) {
		return null;
	}
	let attachments;
	try {
		attachments = await client.findAttachmentsByLocation(brainId, url);
	} catch(error) {
		if(error instanceof ApiError && error.status === 404) {
			console.warn(
				"[Send to TheBrain] by-location endpoint returned 404. " +
				"The desktop app probably needs a rebuild to include the new API route — " +
				"duplicate detection will be skipped until then.",
			);
			return null;
		}
		if(error instanceof TheBrainError) {
			console.warn("[Send to TheBrain] duplicate-detection lookup failed:", error);
			return null;
		}
		throw error;
	}
	console.debug("[Send to TheBrain] dedupe query", { url, attachments });
	// sourceType 2 = Thought (per Attachment.EntityType in TheBrainNetCore).
	const hit = attachments.find((a) => a.sourceType === 2);
	if(!hit) {
		return null;
	}
	let thoughtName = hit.name ?? "existing thought";
	try {
		const thought = await client.getThought(brainId, hit.sourceId);
		thoughtName = thought.name;
	} catch {
		// Fall back to the attachment name if the thought fetch fails.
	}
	return { thoughtId: hit.sourceId, thoughtName };
}
