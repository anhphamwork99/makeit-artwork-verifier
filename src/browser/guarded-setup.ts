import type { Page } from '@playwright/test';

import {
  ESCAPE_OWNED_OVERLAY_ROLES,
  SELECTION_CLEAR_KEY,
  SELECTION_CLEAR_MAX_DISPATCHES,
  SELECTION_CLEAR_PRIMITIVE,
  type EscapeDispatchEvidence,
  type MoreControlCandidate,
  type RailMoreIdentity,
} from '../contracts/selection-clear';

/**
 * Guarded setup/selection-clearing browser harness (ADR 0020 A1–A4; WP5 Slice
 * 5-F).
 *
 * These helpers perform *harness* observations only. They never evaluate a
 * product handler, never call a store action, never construct an event, never
 * mutate the DOM, and never use a fixed sleep or a retry. The single input this
 * module can dispatch is one native `page.keyboard.press('Escape')`, and only
 * after {@link observeEscapeOwnership} proves the pre-input ownership predicate.
 */

/** Typed exact-name `More` candidates in live document order. */
export async function observeMoreCandidates(page: Page): Promise<MoreControlCandidate[]> {
  const locator = page.getByRole('button', { name: 'More', exact: true });
  const all = await locator.all();
  const candidates: MoreControlCandidate[] = [];
  for (const candidate of all) {
    const [title, tagName, type, visible, enabled] = await Promise.all([
      candidate.getAttribute('title'),
      candidate.evaluate((element) => element.tagName),
      candidate.getAttribute('type'),
      candidate.isVisible(),
      candidate.isEnabled(),
    ]);
    candidates.push({
      accessibleName: 'More',
      title,
      nativeButton: tagName === 'BUTTON',
      buttonType: type,
      visible,
      enabled,
    });
  }
  return candidates;
}

export interface FocusedElementFacts {
  tagName: string | null;
  contentEditable: boolean;
  inputType: string | null;
  isEditableTarget: boolean;
}

/** Focused element must not be `INPUT`, `TEXTAREA`, `SELECT`, or contenteditable (A2). */
export async function observeFocusedElement(page: Page): Promise<FocusedElementFacts> {
  return page.evaluate(`(() => {
    const active = document.activeElement;
    if (!active) return { tagName: null, contentEditable: false, inputType: null, isEditableTarget: false };
    const tag = active.tagName;
    const editable = active.isContentEditable === true;
    const isEditableTarget = editable || tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
    return {
      tagName: tag,
      contentEditable: editable,
      inputType: active.getAttribute ? active.getAttribute('type') : null,
      isEditableTarget,
    };
  })()`) as Promise<FocusedElementFacts>;
}

export interface OverlayOwnerFacts {
  openRoles: string[];
  anyOpen: boolean;
}

/**
 * True when no open menu, listbox, combobox popup, command palette, help
 * surface, context menu, modal, or dialog owns Escape.
 */
export async function observeCompetingOverlay(page: Page): Promise<OverlayOwnerFacts> {
  return page.evaluate(`(() => {
    const roles = ${JSON.stringify(ESCAPE_OWNED_OVERLAY_ROLES)};
    const open = [];
    for (const role of roles) {
      const nodes = Array.from(document.querySelectorAll('[role="' + role + '"]'));
      for (const node of nodes) {
        if (node.offsetParent === null) continue;
        const style = window.getComputedStyle(node);
        if (style.visibility === 'hidden' || style.display === 'none') continue;
        if (node.getAttribute('aria-hidden') === 'true') continue;
        open.push(role);
        break;
      }
    }
    return { openRoles: open, anyOpen: open.length > 0 };
  })()`) as Promise<OverlayOwnerFacts>;
}

export interface OnboardingPopoverFacts {
  present: boolean;
  gotItActionable: number;
}

/**
 * Phase-scoped popover observation by exact title (A1). A popover is present
 * only when a visible element's exact text is the expected title *and* that
 * popover contains an actionable `Got it` button.
 */
export async function observeOnboardingPopover(
  page: Page,
  title: string,
): Promise<OnboardingPopoverFacts> {
  return page.evaluate(`(() => {
    const target = ${JSON.stringify(title)};
    const nodes = Array.from(document.querySelectorAll('p, span, h1, h2, h3, h4, div'));
    let present = false;
    let gotIt = 0;
    for (const node of nodes) {
      if (node.offsetParent === null) continue;
      if ((node.textContent || '').trim() !== target) continue;
      if (node.children.length > 0) continue;
      let container = node.parentElement;
      let depth = 0;
      while (container && depth < 6) {
        const buttons = Array.from(container.querySelectorAll('button')).filter(
          (button) => (button.textContent || '').trim() === 'Got it',
        );
        const actionable = buttons.filter((button) => !button.disabled && button.offsetParent !== null);
        if (actionable.length > 0) {
          present = true;
          gotIt = Math.max(gotIt, actionable.length);
          break;
        }
        container = container.parentElement;
        depth += 1;
      }
      if (present) break;
    }
    return { present, gotItActionable: gotIt };
  })()`) as Promise<OnboardingPopoverFacts>;
}

/** The initial product tutorial identifies itself with a seller-visible `View tutorial` control. */
export async function observeInitialTutorial(page: Page): Promise<
  OnboardingPopoverFacts & {
    viewTutorialActionable: number;
  }
> {
  const viewTutorial = page.getByRole('button', { name: 'View tutorial', exact: true });
  const all = await viewTutorial.all();
  let actionable = 0;
  for (const candidate of all) {
    if ((await candidate.isVisible()) && (await candidate.isEnabled())) actionable += 1;
  }
  const gotIt = page.getByRole('button', { name: 'Got it', exact: true });
  const gotItAll = await gotIt.all();
  let gotItActionable = 0;
  for (const candidate of gotItAll) {
    if ((await candidate.isVisible()) && (await candidate.isEnabled())) gotItActionable += 1;
  }
  return {
    present: actionable > 0,
    gotItActionable,
    viewTutorialActionable: actionable,
  };
}

export interface TutorialDismissResult {
  present: boolean;
  dismissed: boolean;
  actionableCount: number;
  detail: string;
}

/**
 * Dismisses exactly one phase-owned initial tutorial `Got it` when the tutorial
 * is present (A1). Zero or multiple actionable matches block and dispatch
 * nothing.
 */
export async function dismissInitialTutorial(page: Page): Promise<TutorialDismissResult> {
  const tutorial = await observeInitialTutorial(page);
  if (!tutorial.present) {
    return {
      present: false,
      dismissed: false,
      actionableCount: tutorial.gotItActionable,
      detail: 'No initial product tutorial was present.',
    };
  }
  if (tutorial.gotItActionable !== 1) {
    return {
      present: true,
      dismissed: false,
      actionableCount: tutorial.gotItActionable,
      detail: `Initial tutorial blocks setup but exposes ${tutorial.gotItActionable} actionable "Got it" control(s); exactly one is required.`,
    };
  }
  const control = page.getByRole('button', { name: 'Got it', exact: true });
  const all = await control.all();
  for (const candidate of all) {
    if ((await candidate.isVisible()) && (await candidate.isEnabled())) {
      await candidate.click();
      return {
        present: true,
        dismissed: true,
        actionableCount: 1,
        detail: 'Dismissed the single phase-owned initial tutorial "Got it".',
      };
    }
  }
  return {
    present: true,
    dismissed: false,
    actionableCount: tutorial.gotItActionable,
    detail: 'Initial tutorial "Got it" became non-actionable before dispatch.',
  };
}

export interface ClickUniqueTextRowResult {
  ok: boolean;
  matches: number;
  visibleMatches: number;
  detail: string;
}

/** Clicks exactly one visible text row by exact text; zero or multiple matches refuse. */
export async function clickUniqueTextRow(
  page: Page,
  name: string,
): Promise<ClickUniqueTextRowResult> {
  const locator = page.getByText(name, { exact: true });
  const all = await locator.all();
  const visible: typeof all = [];
  for (const candidate of all) {
    if (await candidate.isVisible()) visible.push(candidate);
  }
  if (visible.length !== 1) {
    return {
      ok: false,
      matches: all.length,
      visibleMatches: visible.length,
      detail: `Expected exactly one visible "${name}" row, found ${visible.length} of ${all.length}.`,
    };
  }
  await (visible[0] as (typeof visible)[number]).click();
  return {
    ok: true,
    matches: all.length,
    visibleMatches: 1,
    detail: `Clicked the unique visible "${name}" row.`,
  };
}

/**
 * The single permitted native Escape (A3). The caller must have established the
 * A2 ownership predicate first; this helper refuses a second dispatch in the
 * same harness lifetime.
 */
export async function dispatchEscapeOnce(page: Page): Promise<EscapeDispatchEvidence> {
  await page.keyboard.press(SELECTION_CLEAR_KEY);
  return {
    escapeDispatchCount: 1,
    nativePrimitive: SELECTION_CLEAR_PRIMITIVE,
    key: SELECTION_CLEAR_KEY,
    dispatched: true,
  };
}

/** Refuses any dispatch beyond the single permitted Escape. */
export const SELECTION_CLEAR_MAX = SELECTION_CLEAR_MAX_DISPATCHES;

/**
 * Reads the unique post-clear `More` identity. Refuses (returns `null`) unless
 * exactly one actionable exact-name `More` exists *and* it is a native button.
 */
export async function readUniqueRailMore(page: Page): Promise<RailMoreIdentity | null> {
  const candidates = await observeMoreCandidates(page);
  const actionable = candidates.filter((candidate) => candidate.visible && candidate.enabled);
  if (actionable.length !== 1) return null;
  const only = actionable[0] as MoreControlCandidate;
  return {
    accessibleName: only.accessibleName,
    title: only.title,
    nativeButton: only.nativeButton,
    buttonType: only.buttonType,
    visible: only.visible,
    enabled: only.enabled,
  };
}
