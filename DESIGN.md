---
name: VoiceFlow Lite
description: A restrained dark workspace for recording, cleaned words, and voice replay.
colors:
  background: "#0a0a0a"
  surface: "#141414"
  foreground: "#ededed"
  muted: "#a1a1a1"
  border: "#292929"
  control-border: "#737373"
  success: "#63d99a"
  warning: "#f5b963"
  error: "#ff8585"
  focus: "#87bfff"
  action-hover: "#d6d6d6"
  action-held: "#c4c4c4"
typography:
  headline:
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif'
    fontSize: "40px"
    fontWeight: 500
    lineHeight: 1.2
    letterSpacing: "-0.035em"
  headline-mobile:
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif'
    fontSize: "32px"
    fontWeight: 500
    lineHeight: 1.2
    letterSpacing: "-0.035em"
  title:
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif'
    fontSize: "18px"
    fontWeight: 500
    lineHeight: 1.5
    letterSpacing: "-0.015em"
  body:
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif'
    fontSize: "16px"
    fontWeight: 400
    lineHeight: 1.7
  reading:
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif'
    fontSize: "18px"
    fontWeight: 400
    lineHeight: 1.7
  action:
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif'
    fontSize: "16px"
    fontWeight: 600
  label:
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif'
    fontSize: "14px"
    fontWeight: 500
    lineHeight: "24px"
  support:
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif'
    fontSize: "13px"
    fontWeight: 400
    lineHeight: 1.6
  metadata:
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif'
    fontSize: "12px"
    fontWeight: 400
    lineHeight: "20px"
rounded:
  small: "4px"
  control: "6px"
  container: "8px"
spacing:
  space-1: "4px"
  space-2: "8px"
  space-3: "16px"
  space-4: "24px"
  space-5: "32px"
components:
  button-primary:
    backgroundColor: "{colors.foreground}"
    textColor: "{colors.background}"
    typography: "{typography.action}"
    rounded: "{rounded.control}"
    padding: "12px 16px"
  button-primary-hover:
    backgroundColor: "{colors.action-hover}"
  button-primary-held:
    backgroundColor: "{colors.action-held}"
  button-primary-disabled:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.muted}"
  button-secondary:
    backgroundColor: "{colors.background}"
    textColor: "{colors.foreground}"
    rounded: "{rounded.control}"
    padding: "8px 12px"
  button-secondary-hover:
    backgroundColor: "{colors.surface}"
  transcript:
    backgroundColor: "{colors.background}"
    textColor: "{colors.foreground}"
    typography: "{typography.reading}"
  workspace:
    backgroundColor: "{colors.background}"
    rounded: "{rounded.container}"
  section-heading:
    typography: "{typography.label}"
    padding: "16px 24px"
  edition:
    textColor: "{colors.muted}"
    rounded: "{rounded.small}"
    padding: "2px 6px"
  disclosure:
    textColor: "{colors.muted}"
    padding: "16px 24px"
---

# Design System: VoiceFlow Lite

## Overview

**Creative North Star: "The ruled voice workspace"**

A dark, technical interface inspired by Vercel, using the user's specified palette and the project's existing system sans-serif. The surface stays quiet so that the recording action, readable transcript, and generated voice output carry the hierarchy.

One continuous frame groups related work. Fine rules establish structure; high-contrast controls establish action. The system uses neither decorative gradients nor glass, shadows, or ornamental motion. Product behavior and native browser affordances remain visible.

**Key Characteristics:**

- Near-black surfaces and restrained typography.
- Continuous ruled containers with generous internal spacing.
- A white primary action and clear keyboard focus.
- Semantic colors attached to actual application states.
- Native audio controls and progressive disclosure for measurements.

## Colors

The palette is neutral at rest, with state colors reserved for meaningful feedback. Frontmatter values mirror the CSS custom properties in `public/style.css`.

### Primary

- **Soft white:** `foreground` supplies primary text and the recording action's fill. The action uses `background` for its text and icon.
- **Action hover / held:** the two neutral action variants distinguish hover and active recording without introducing another accent.

### Neutral

- **Near black:** `background` is both the page and main workspace surface.
- **Secondary black:** `surface` supports hover, disabled, and keyboard-hint treatments.
- **Secondary gray:** `muted` carries supporting copy, placeholders, and neutral status text.
- **Structural gray:** `border` draws decorative separators and the outer workspace frame.
- **Control gray:** `control-border` defines enabled secondary controls and keyboard hints.

### State colors

- **Success green:** final transcript and available replay labels, plus the speaking state.
- **Warning amber:** processing and notices identifying mock or test-tone operation.
- **Error coral:** errors and the active recording indicator. The accompanying label always distinguishes recording from failure.
- **Focus blue:** keyboard outlines, selection, and the transcript caret.

**The Control Boundary Rule.** Structural dividers describe grouping; enabled interactive boundaries use the stronger control border. Do not substitute a decorative divider for an enabled control boundary.

**The State Color Rule.** Use semantic color only when the application supplies the corresponding state, and always retain a readable text label.

Secondary text has a measured contrast of at least 7.13:1 against either shipped surface. Enabled control borders reach at least 3.89:1; focus reaches at least 9.59:1 against the adjacent dark surface. Structural rules are intentionally subdued and are not enabled control boundaries.

## Typography

**Display and body font:** the existing locally available system stack in the frontmatter. There is no remote font request, separate display family, or decorative monospace voice.

The type is direct and restrained. Regular and medium weights do most of the work; semibold distinguishes the brand and primary action. The root body size is 16px. Important reading content uses 18px, including the read-only transcript.

### Hierarchy

- **Headline:** the headline roles provide desktop and mobile sizes. The second line uses secondary text color without changing its weight.
- **Title:** short recording guidance uses the title role; on smaller screens it reduces to the body size.
- **Body:** introductory instructions use the body role.
- **Reading:** transcript text uses the reading role, including its placeholder.
- **Label:** section headings use the label role with sentence case.
- **Support / metadata:** helper text, status, footer, and measurement descriptions use the smaller supporting roles. Keyboard hint keycaps are compact annotations (11px), not body copy.

**The Reading Size Rule.** Keep the transcript at the reading size at every breakpoint. Layout may stack; the words must remain readable.

Use tabular numerals for latency summaries, measurements, and media timing. Preserve the text-selection treatment and visible focus supplied by the stylesheet.

## Layout

The main container is centered and capped at 1120px, with 32px side gutters on larger screens. The brand header shares its alignment through a 1184px outer container and matching inset. The desktop workspace uses a recording column of 34% with a 280px minimum, and a flexible results column. The results contain transcript and output separated by a rule. Latency spans the workspace width.

The frame itself has no padding: each text-bearing region supplies its own inset. Headers and output use 24px horizontal padding on wide screens; the recording body uses 32px above and 24px on the other sides. The reusable rhythm is the spacing scale in the frontmatter. Compact controls and helper groups also use 12px intervals. Do not add wrapper padding that breaks continuous internal rules.

Responsive behavior follows the existing CSS maximum-width breakpoints:

- **959px:** the recording column uses 40% with a 260px minimum; region insets reduce to 16px, the introduction stacks, and footer content aligns vertically.
- **699px:** the workspace becomes one column, following recording → transcript → audio → latency. Side gutters become 24px, the header becomes more compact, and the large microphone illustration is omitted while the recording button retains its icon.
- **359px:** side gutters reduce to 16px and the secondary header descriptor is hidden.

Flexible regions use zero minimum inline size, labels can wrap, and measurement descriptions wrap beside right-aligned values. The transcript remains vertically resizable. Verify reflow with real text and native audio controls, including narrow and zoom-equivalent CSS viewports; do not suppress document overflow to hide a layout problem.

## Elevation & Depth

The interface is flat. Borders, spacing, and the secondary surface establish relationships; there are no box shadows. Hover feedback changes neutral fills and borders. No gradients, glass, blur, or animated entrances are part of the system.

**The Flat Surface Rule.** Keep grouping in rules and spacing. A floating card or shadow is not a substitute for the existing spatial structure.

## Shapes

Controls use the control radius, and larger containing frames use the container radius. Internal workspace partitions stay square and meet their shared rules. The edition label and keyboard annotations use the small radius. Status dots are circular because they indicate state rather than contain content.

Borders are one pixel. Icons are small inline stroke SVGs with consistent weight; they are not filled icon tiles. Native media controls retain the browser's internal shape and affordances rather than being rebuilt to match a custom player silhouette.

## Components

### Buttons

The primary action is clear and substantial: a full-width recording button in its pane, with a microphone icon, action typography, and a minimum height of 56px. Its hover and held variants use the neutral action tokens. During setup, it is disabled and uses the secondary surface, muted text, and a control border.

Secondary actions use an outlined treatment, supporting text size, and a minimum height of 40px. Hover raises the border contrast and uses the secondary fill; active uses the structural-gray fill. Disabled controls retain readable labels, reduce boundary contrast, and use the default cursor. Avoid opacity on the entire control.

Focus uses a two-pixel focus-blue outline offset four pixels. The recording button preserves hold-to-record pointer behavior and the focused Space hold/release interaction. Cancel / Stop and Escape remain available when work or playback can be stopped. Enable playback appears only when playback needs recovery.

### Containers and headings

Use a unified framed region for related work, with internal ruled partitions and inset content. Section headings pair a sentence-case label with concise status text. Header contents wrap when required. Do not turn each section into an independent floating card.

### Transcript

The transcript is a native read-only textarea with no independent decorative box inside the workspace. Its inset and section rules establish its location. Preserve the label, help association, keyboard focus, vertical resizing, placeholder, and text-selection behavior. Final and empty states must come from actual results; the interface does not support transcript editing or approval.

### Voice output

Keep the native audio element with playback, pause, seek, and volume controls and dark color-scheme support. The empty state explains that audio appears after recording and can be replayed without generating again. The readiness label turns green only when audio exists. A new recording replaces the current clip.

### State and recovery feedback

Status uses a small dot plus a text label. Ready is neutral, listening is coral, processing is amber, and speaking is green. Errors appear inline near recording controls with the supplied recovery message and alert semantics. Text and output success labels reflect their actual data states. Never add a semantic color as decoration.

### Latency disclosure

Retain the native details/summary interaction. Hover uses the secondary fill, and keyboard focus is inset four pixels so the outline remains within the frame. Expanded measurements form a two-column definition list with wrapping descriptions and tabular, right-aligned values. Keep estimates explicitly labeled as estimates.

### Motion and accessibility

No motion is needed for the shipped interaction. The reduced-motion media query explicitly disables animations, transitions, and smooth scrolling. Preserve live status announcements, alert semantics, disabled states, helper associations, and visible keyboard focus. Content remains visible without entrance animation.

## Do's and Don'ts

### Do:

- **Do** keep related content and its action within the same continuous ruled workspace.
- **Do** use the stronger control border for enabled outlined actions and keep structural rules subdued.
- **Do** preserve the reading size, visible focus, and text labels alongside state colors.
- **Do** retain native textarea, audio, and disclosure affordances.
- **Do** test the primary workflow, error recovery, keyboard traversal, and narrow reflow with real rendered content.

### Don't:

- **Don't** introduce decorative gradients, glass effects, excessive shadows, or unnecessary animation.
- **Don't** use semantic colors for decoration or invented measurements.
- **Don't** add editing, approval, history, download, voice selection, or other unsupported controls.
- **Don't** replace the unified frame with floating cards or clip focus rings to contain the layout.
- **Don't** shrink transcript text to make a narrow layout fit.
