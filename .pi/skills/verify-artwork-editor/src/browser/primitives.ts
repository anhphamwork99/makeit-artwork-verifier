import { readFileSync } from 'node:fs';

import type { Page } from '@playwright/test';

import { sha256Of } from '../catalogue/resources';
import type { ResolvedResource } from '../resources/resolve';
import {
  INTERACTION_TARGET,
  verifyInteractionTarget,
  type InteractionPoint,
  type InteractionRegion,
  type InteractionTargetCandidate,
} from './public-controls';

/**
 * Native browser primitives (specification 9.1/11; WP5 Slice 5-A).
 *
 * The claimed transition is always real native pointer/keyboard/file input on
 * the live page after the seal. Every pointer primitive verifies its hit point
 * inside the live listening region with the declared `INTERACTION_TARGET` safety
 * inset *before* dispatching anything, and refuses otherwise. A refusal is a
 * harness-blocking precondition, never a product result; a dispatched action
 * only ever produces an action log, which is action evidence and never
 * readiness or Oracle authority.
 */

export interface NativePointerDragInput {
  page: Page;
  target: InteractionTargetCandidate;
  dx: number;
  dy: number;
  /** Number of intermediate mouse-move steps; each is a real dispatched event. */
  steps?: number;
}

export interface PointerActionLog {
  primitive: 'pointer.drag';
  from: InteractionPoint;
  to: InteractionPoint;
  plannedDelta: { x: number; y: number };
  dispatchedSteps: number;
  region: InteractionRegion;
  startedAt: string;
  completedAt: string;
}

export type NativePointerDragResult =
  | { ok: true; log: PointerActionLog }
  | {
      ok: false;
      reason: 'hit-point-unavailable';
      detail: string;
      code: 'HIT_POINT_UNAVAILABLE';
    };

export async function pointerDrag(input: NativePointerDragInput): Promise<NativePointerDragResult> {
  const verdict = verifyInteractionTarget(input.target, INTERACTION_TARGET.safetyInsetPx);
  if (!verdict.ok) {
    return {
      ok: false,
      reason: 'hit-point-unavailable',
      code: 'HIT_POINT_UNAVAILABLE',
      detail: `Native pointer drag refused before dispatch: ${verdict.detail}`,
    };
  }

  const { page } = input;
  const from = verdict.point;
  const to = { x: from.x + input.dx, y: from.y + input.dy };
  const steps = input.steps ?? 8;
  const startedAt = new Date().toISOString();

  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  for (let step = 1; step <= steps; step += 1) {
    const progress = step / steps;
    await page.mouse.move(from.x + input.dx * progress, from.y + input.dy * progress);
  }
  await page.mouse.move(to.x, to.y);
  await page.mouse.up();

  return {
    ok: true,
    log: {
      primitive: 'pointer.drag',
      from,
      to,
      plannedDelta: { x: input.dx, y: input.dy },
      dispatchedSteps: steps,
      region: verdict.region,
      startedAt,
      completedAt: new Date().toISOString(),
    },
  };
}

export interface NativePointerClickInput {
  page: Page;
  target: InteractionTargetCandidate;
}
export type NativePointerClickResult =
  | {
      ok: true;
      log: {
        primitive: 'pointer.click';
        point: InteractionPoint;
        region: InteractionRegion;
        at: string;
      };
    }
  | { ok: false; reason: 'hit-point-unavailable'; detail: string; code: 'HIT_POINT_UNAVAILABLE' };

export async function pointerClick(
  input: NativePointerClickInput,
): Promise<NativePointerClickResult> {
  const verdict = verifyInteractionTarget(input.target, INTERACTION_TARGET.safetyInsetPx);
  if (!verdict.ok) {
    return {
      ok: false,
      reason: 'hit-point-unavailable',
      code: 'HIT_POINT_UNAVAILABLE',
      detail: `Native pointer click refused before dispatch: ${verdict.detail}`,
    };
  }
  await input.page.mouse.click(verdict.point.x, verdict.point.y);
  return {
    ok: true,
    log: {
      primitive: 'pointer.click',
      point: verdict.point,
      region: verdict.region,
      at: new Date().toISOString(),
    },
  };
}

// ── Slice 5-C public control and native file input primitives ───────────────

const FILE_INPUT_SELECTOR = 'input[type=file]';

export interface ActivateControlResult {
  ok: boolean;
  detail: string;
  code?: 'PUBLIC_CONTROL_UNAVAILABLE' | 'PUBLIC_CONTROL_AMBIGUOUS';
  at: string;
  matchCount: number;
  visibleCount: number;
  accessibleName: string;
}

/**
 * Activates exactly one visible, enabled button by exact accessible name.
 * Zero, hidden, disabled, or multiple matches refuse *before* activation.
 */
export async function activateControl(input: {
  page: Page;
  accessibleName: string;
}): Promise<ActivateControlResult> {
  const at = new Date().toISOString();
  const locator = input.page.getByRole('button', {
    name: input.accessibleName,
    exact: true,
  });
  const all = await locator.all();
  const actionable: number[] = [];
  for (let index = 0; index < all.length; index += 1) {
    const candidate = all[index];
    if (!candidate) continue;
    if ((await candidate.isVisible()) && (await candidate.isEnabled())) actionable.push(index);
  }
  const base = {
    at,
    matchCount: all.length,
    visibleCount: actionable.length,
    accessibleName: input.accessibleName,
  };
  if (all.length === 0) {
    return {
      ...base,
      ok: false,
      code: 'PUBLIC_CONTROL_UNAVAILABLE',
      detail: `No button with accessible name "${input.accessibleName}" is present.`,
    };
  }
  if (actionable.length === 0) {
    return {
      ...base,
      ok: false,
      code: 'PUBLIC_CONTROL_UNAVAILABLE',
      detail: `Button "${input.accessibleName}" exists but is hidden or disabled.`,
    };
  }
  if (actionable.length > 1) {
    return {
      ...base,
      ok: false,
      code: 'PUBLIC_CONTROL_AMBIGUOUS',
      detail: `${actionable.length} visible buttons match accessible name "${input.accessibleName}"; no first-match fallback is permitted.`,
    };
  }
  await (all[actionable[0] as number] as Exclude<(typeof all)[number], undefined>).click();
  return {
    ...base,
    ok: true,
    detail: `Activated public control "${input.accessibleName}".`,
  };
}

export interface SetFileInputResult {
  ok: boolean;
  detail: string;
  code?: 'FILE_INPUT_UNAVAILABLE' | 'FILE_INPUT_ACCEPT_MISMATCH' | 'RESOURCE_BYTES_MISMATCH';
  at: string;
  selectedName: string | null;
  actionEpoch: string;
  predispatch: { sha256: string; byteLength: number } | null;
}

/**
 * Resolves exactly one native file input inside the exact open dialog, verifies
 * its `accept`, re-hashes the checked-in file immediately before dispatch, and
 * calls `setInputFiles`. The harness never creates a blob URL, never evaluates
 * the product upload handler, and never mutates the store itself.
 */
export async function setFileInput(input: {
  page: Page;
  dialogAccessibleName: string;
  accept: string;
  resource: ResolvedResource;
}): Promise<SetFileInputResult> {
  const at = new Date().toISOString();
  const actionEpoch = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  const dialog = input.page.getByRole('dialog', {
    name: input.dialogAccessibleName,
    exact: true,
  });
  if ((await dialog.count()) !== 1) {
    return {
      ok: false,
      code: 'FILE_INPUT_UNAVAILABLE',
      detail: `Dialog "${input.dialogAccessibleName}" is not uniquely open.`,
      at,
      selectedName: null,
      actionEpoch,
      predispatch: null,
    };
  }
  const inputs = await dialog.locator(FILE_INPUT_SELECTOR).all();
  if (inputs.length !== 1) {
    return {
      ok: false,
      code: 'FILE_INPUT_UNAVAILABLE',
      detail: `Dialog "${input.dialogAccessibleName}" exposes ${inputs.length} native file inputs; exactly one is required.`,
      at,
      selectedName: null,
      actionEpoch,
      predispatch: null,
    };
  }
  const fileInput = inputs[0] as Exclude<(typeof inputs)[number], undefined>;
  const accept = (await fileInput.getAttribute('accept')) ?? '';
  const accepted = accept
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  if (!accepted.includes('image/png') || accepted.join(',') !== input.accept) {
    return {
      ok: false,
      code: 'FILE_INPUT_ACCEPT_MISMATCH',
      detail: `Native file input accepts "${accept}", not the required "${input.accept}".`,
      at,
      selectedName: null,
      actionEpoch,
      predispatch: null,
    };
  }

  // Re-read and re-hash the exact checked-in file immediately before dispatch.
  let predispatch: { sha256: string; byteLength: number };
  try {
    const bytes = readFileSync(input.resource.absoluteFilePath);
    predispatch = { sha256: sha256Of(bytes), byteLength: bytes.byteLength };
  } catch (error) {
    return {
      ok: false,
      code: 'RESOURCE_BYTES_MISMATCH',
      detail: `Resource "${input.resource.logicalId}" is unreadable before dispatch: ${(error as Error).message}`,
      at,
      selectedName: null,
      actionEpoch,
      predispatch: null,
    };
  }
  if (
    predispatch.sha256 !== input.resource.sha256 ||
    predispatch.byteLength !== input.resource.byteLength
  ) {
    return {
      ok: false,
      code: 'RESOURCE_BYTES_MISMATCH',
      detail: `Resource "${input.resource.logicalId}" bytes changed immediately before dispatch.`,
      at,
      selectedName: null,
      actionEpoch,
      predispatch,
    };
  }

  await fileInput.setInputFiles(input.resource.absoluteFilePath);
  const selectedName = await fileInput.evaluate((element) => {
    const files = (element as HTMLInputElement).files;
    return files && files.length > 0 ? (files[0]?.name ?? null) : null;
  });
  return {
    ok: true,
    detail: `Dispatched resource "${input.resource.logicalId}" (${selectedName ?? input.resource.filename}) through the native file input.`,
    at,
    selectedName,
    actionEpoch,
    predispatch,
  };
}
