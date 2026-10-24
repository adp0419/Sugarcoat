---
name: VoiceFlow
description: A focused, dark voice studio.
colors:
  page: "#0a0a0a"
  surface: "#0a0a0a"
  subtle: "#141414"
  text: "#ededed"
  secondary: "#a1a1a1"
  line: "#292929"
  control-border: "#737373"
  primary: "#ededed"
  on-primary: "#0a0a0a"
  success: "#63d99a"
  warning: "#f5b963"
  error: "#ff8585"
  focus: "#87bfff"
typography:
  display:
    fontFamily: "DM Sans, sans-serif"
    fontSize: "52px"
    fontWeight: 600
    lineHeight: 1.15
    letterSpacing: "-2px"
  body:
    fontFamily: "DM Sans, sans-serif"
    fontSize: "16px"
    fontWeight: 400
    lineHeight: 1.55
  transcript:
    fontFamily: "DM Sans, sans-serif"
    fontSize: "18px"
    fontWeight: 400
    lineHeight: 1.7
  label:
    fontFamily: "DM Sans, sans-serif"
    fontSize: "14px"
    fontWeight: 500
rounded:
  sm: "6px"
  md: "8px"
spacing:
  half: "4px"
  sm: "8px"
  md: "16px"
  lg: "24px"
  xl: "32px"
components:
  button-primary:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.on-primary}"
    rounded: "{rounded.sm}"
    height: "44px"
---

# Design System: VoiceFlow

## Overview

A restrained, technical studio, following the user's Vercel reference. A single ruled workspace gives recording, review, and approval a clear hierarchy. The interface stays quiet while speech and text carry the content.

## Colors

Near-black backgrounds and off-white primary actions define the interface. Gray distinguishes secondary content and structural rules. Green, amber, and red communicate success, limitations, and blocking errors. Blue is reserved for keyboard focus.

## Typography

DM Sans is bundled locally with its OFL license. Display text uses 52px on wide screens, 42px on tablets, and 36px on phones; short desktop viewports use 44px. UI labels range from 12–16px. Transcripts and editable text remain at least 18px. Timers use tabular numerals at 32px.

## Layout

A 1200px container has 32px horizontal padding, reduced to 16px on phones. The idle workspace puts recording beside stacked review and playback areas. At 1100px and above, ready review and playback use three columns so approval sits beside the text. At 900px and below, the steps stack in reading order. Components use 16–28px spacing. Transcript text wraps; technical tables scroll within their panel.

## Elevation & Depth

One-pixel borders and small changes in surface tone separate regions. Shadows are reserved for floating service details and tooltips. The shadow token is `0 8px 24px rgba(0, 0, 0, 0.3)`.

## Shapes

Inputs and buttons use 6px corners. The workspace header uses 8px top corners. The record and play buttons are circular; sequential step markers use compact 5px corners.

## Components

Primary actions use off-white with dark text and a gray hover state. Recording turns the microphone action red and exposes the stop icon. Disabled buttons remain visibly labeled. Focus uses a 3px blue outline. Selected view/style controls use a lighter neutral surface.

Review examples are explicitly labeled and disappear when processing begins. Meaning-check, fallback, error, and synthetic-audio labels remain part of the workflow. Every step stays in the document. Reduced-motion mode disables transitions and animation.

## Do's and Don'ts

- Do preserve the original transcript, edit reasons, meaning checks, and approval controls.
- Do reserve color for actionable state and keep transcript text readable.
- Do use the existing SVG icon vocabulary and semantic controls.
- Don't add decorative gradients, glass surfaces, or unsupported product features.
