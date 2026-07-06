# Design System — agent-cc

## Product Context
- **What this is:** A local-first agent command centre. Single browser tab, three vertical panels (workspace list / terminal / memory + decisions). Streams real tmux sessions into xterm.js, with a SQLite-backed memory harness that compounds across runs and a Cmd-K launcher for everything else.
- **Who it's for:** A solo developer running multiple AI coding agents (Claude Code, Aider) across multiple repos on one machine. Power user. Keyboard-first.
- **Space/industry:** Developer tools. Adjacent to: Conductor, OpenClaw, Claude Code desktop, terminal multiplexers (tmux, Zellij, WezTerm), JetBrains project tool windows, VS Code's three-pane layout.
- **Project type:** Local-first desktop-class web app. One continuous 3-panel surface, no multi-page navigation, no marketing surface, no auth. The dashboard IS the product.

## Aesthetic Direction
- **Direction:** "Three-pane terminal-in-the-browser." The chrome exists to make the terminal + memory the heroes. Inspired by JetBrains' project tool windows, VS Code's editor-with-sidebars, tmux status bars, and tools like lazygit, btop, k9s.
- **Decoration level:** Minimal-but-intentional. The terminal is the decoration. The memory panel is the compound knowledge. Everything else is a thin frame.
- **Mood:** Calm, capable, lived-in. The user opens the tab and sees their work + their memory, not the app.
- **Reference sites:** JetBrains IntelliJ (project tool window), VS Code (left rail + editor + outline), k9s.io, btop (GitHub), lazygit, Raycast (for the command-palette discipline), Warp (for serious terminal UI without marketing tone).

## Typography
- **Display / hero:** Inter 700 (28–40px) — used only for the hero line on the empty state and the design preview itself. Never in the running app.
- **UI / labels:** Inter 500/600 (14–20px) — section titles, button labels, the one paragraph of explanatory copy per screen.
- **Body:** Inter 400 (14px, 1.5 line-height) — used for the one paragraph of chrome copy per screen.
- **Data / tables / paths / status:** JetBrains Mono 500 (14px) — repo names, branches, paths, timestamps, PIDs, exit codes, status labels, run metadata.
- **Code / terminal:** JetBrains Mono 400 (13px) — terminal pane output is always 13px regardless of viewport.
- **Micro:** JetBrains Mono 500 (11px, uppercase, 0.06em letter-spacing) — metadata, hints, hint labels.
- **Loading:** Bunny Fonts CDN (`https://fonts.bunny.net/css?family=jetbrains-mono|inter`). Self-host if the user's network blocks it.
- **Scale (rem):** 0.6875 (micro) · 0.75 (label) · 0.875 (body) · 1.25 (h2) · 1.75 (display) · 2.5 (hero).

## Color
- **Approach:** Restrained. Two greyscale surfaces, four foreground tones, six status tokens, and the agent's ANSI palette. The terminal inherits its colour from the agent — not from us. Our job is to make the frame disappear.
- **Primary (foreground):** `--fg-0: #ededed` — primary text, primary buttons, focus rings.
- **Secondary (foreground):** `--fg-1: #a8a8a8` — secondary text, ended-status indicator, secondary buttons.
- **Tertiary:** `--fg-2: #6b6b6b` — hints, disabled, micro labels.
- **Quaternary:** `--fg-3: #454545` — disabled on disabled.
- **Surfaces (dark, default):** `--bg-0: #0a0a0a` (page) · `--bg-1: #111111` (card) · `--bg-2: #1a1a1a` (elevated) · `--bg-3: #232323` (hover).
- **Surfaces (light, opt-in):** `--bg-0: #fafaf9` · `--bg-1: #ffffff` · `--bg-2: #f4f4f3` · `--bg-3: #e8e8e6`.
- **Borders:** `--border-1: #1f1f1f` · `--border-2: #2a2a2a` · `--border-3: #3a3a3a` (dark); warm-grey equivalents in light.
- **Semantic / status:** running `#4ade80` (green-400) · ended `#a8a8a8` (fg-1) · error `#f87171` (red-400) · idle `#6b6b6b` (fg-2) · warn `#fbbf24` (amber-400) · info `#60a5fa` (blue-400).
- **Agent ANSI (the terminal's only colour):** black `#1a1a1a` · red `#f87171` · green `#4ade80` · yellow `#fbbf24` · blue `#60a5fa` · magenta `#c084fc` · cyan `#22d3ee` · white `#ededed`. Inherited from the agent's stdout; we do not theme it.
- **Dark mode:** Default. Light mode is a `[data-theme="light"]` override; user can toggle with the persistent button in the top-right.

## Spacing
- **Base unit:** 4px.
- **Density:** Compact. A power tool; pixels are precious.
- **Scale (px):** 4 (s-1) · 8 (s-2) · 12 (s-3) · 16 (s-4) · 24 (s-5) · 32 (s-6) · 48 (s-7).

## Layout
- **Approach:** Three vertical panels, fixed. The dashboard is one continuous 3-pane surface; there is no navigation between "list" and "detail" — the left rail IS the navigation, the centre IS the work, the right panel IS the memory.
- **Top command bar (36px):** Sticky to the top of the viewport. Brand on the left, Cmd-K prompt centre (idle: `type to find a workspace, or ⌘K`; focused: real input), global meta on the right.
- **Left rail (280px, fixed):** Vertical list of workspace cards (variant A compressed into a row: status pill + repo / branch / 2-line terminal preview / last run + exit). Active workspace has a 2px left border in the running status colour. j/k navigation. Independently scrolling.
- **Centre pane (flex 1, min 600px):** Full-bleed xterm.js terminal. 32px header above the pane (repo · branch · status · agent · pid on the left, `↑ Inject context` and `Restart` ghost buttons on the right). Skeleton terminal with "Connecting…" overlay during WebSocket connect. Freezes in read-only mode when session ends.
- **Right panel (280px, fixed, drag-resizable):** Three tabs in the header — **Memory** (default; per-workspace decisions, gotchas, run summaries, project overlays, with FTS5+vec search), **Run history** (last 10 runs, becomes default when session ends), **Inject preview** (ContextPack preview when the user clicks "Inject context"). The right panel is always visible by default — memory is the value prop, it earns the pixels.
- **Responsive collapse:** Below 1024px, the right panel becomes a modal overlay (Cmd-K `right` toggles it), the left rail hides behind Cmd-1, the centre is full-width. Below 768px (mobile), the dashboard says "Best on a larger screen" and offers a read-only summary.
- **Border radius:** 2 / 4 / 6 / 8px. Terminal output is NEVER rounded. Status pills are 4px. Cards are 6px. Modals are 8px. No "bubble" rounded corners.

## Motion
- **Approach:** Minimal-functional. Transitions exist only to communicate state, not for delight.
- **Easing:** `ease-out` for entering (modals, tooltips) · `ease-in` for exiting · `ease-in-out` for movement (resize, sidebar toggle).
- **Duration:** micro 50–100ms (hover, focus rings) · short 150–250ms (modals, tooltips) · medium 250–400ms (page transitions) · long 400–700ms (rare, only for status-pill colour changes that should feel intentional).
- **No parallax, no scroll-linked animation, no decorative motion.**

## Decisions Log
| Date | Decision | Rationale |
|------|----------|-----------|
| 2026-06-28 | Two-family type system: JetBrains Mono + Inter | Mono for data, sans for chrome. No display fonts, no system-ui as primary. |
| 2026-06-28 | Restrained palette: greyscale + 6 status tokens + agent ANSI | The terminal inherits colour from the agent; our job is to disappear. |
| 2026-06-28 | 4px spacing base, compact density | Power tool; pixels are precious. |
| 2026-06-28 | Small radius scale (2/4/6/8px), no bubble corners | Terminal output is never rounded; chrome matches. |
| 2026-06-28 | Cmd-K as primary navigation (replaces menu bar) | Keyboard-first; one user, one machine; faster than clicking for repeat actions. |
| 2026-06-28 | Full-viewport terminal by default, sidebar collapsed | Opposite of "show me everything"; user trusts the system; sidebar is one click away. |
| 2026-06-28 | Dark-default, light as opt-in | Terminals are dark; the frame matches the agent's environment. |
| 2026-06-28 | Status pills: 6px dot + label, 1px border, no fill | Colour is the signal; no decorative fills. |
| 2026-06-28 | No purple gradients, no 3-column feature grids, no hero sections, no colored left-borders, no emoji-as-design | Anti-AI-slop; terminal is the brand. |
| 2026-06-28 | Anti-pattern enforcement: reject any PR that introduces decorative colour, generic SaaS patterns, or marketing-tone copy | Drift happens silently; codify the rules so the next contributor (or future-you) doesn't re-introduce them. |

## Anti-Patterns (rejected explicitly)
- **Purple / blue gradients** as accents or backgrounds. Ever.
- **3-column icon-in-coloured-circle feature grids.** This is not a marketing page.
- **Hero sections with centered everything.** The dashboard is not a landing page.
- **Colored left-borders on cards** to denote status. Use a status pill, or colour the relevant text, or both. Never the left edge.
- **Emoji as design element** (large emoji in cards, emoji-as-icon, emoji-as-button). Emoji can appear in terminal output (where the agent puts them) but not in our chrome.
- **System UI font as the primary.** It is acceptable as a fallback when fonts fail to load. It is not the design.
- **Decorative blobs, blur backgrounds, glassmorphism.** The terminal is the visual; chrome must be invisible.
- **"Tailwind-default card with shadow and padding-6."** Cards are 1px border, 6px radius, 16px padding. No shadows. The terminal is sharp; chrome is sharp.
- **"Clean, modern, minimalist" as design rationale.** Specificity over vibes. The decisions above are the rationale.

## Accessibility
- **Contrast:** All foreground/background pairs ≥4.5:1. Status tokens are tested against `--bg-1` and `--bg-2`.
- **Keyboard nav:** `/` focuses command palette · `j/k` moves between cards · `Enter` opens · `Esc` goes back · `?` opens a shortcut cheat sheet. All interactive elements reachable via Tab.
- **Touch targets:** Minimum 28px height (matching the button height). Status pills are 18–20px because they are not interactive.
- **Screen reader:** Status pills include `aria-label="running"`. The terminal pane has `aria-live="polite"` so screen readers announce new output.
- **Reduced motion:** All transitions ≤400ms. No scroll-linked animation. Respect `prefers-reduced-motion: reduce` to disable the few that remain.

## Open Decisions (deferred)
- **Status pill colour spec per state** — partially specified (running/ended/error/idle/warn/info are locked); the visual treatment of "queued" and "starting" is implied but not pixel-perfect.
- **Multiple browser tabs on the same workspace race policy** — engineering decision, not a design decision. Two control-mode clients in two tabs = two streams; needs a UI choice (mirror? last-writer-wins?).
- **"Create workspace" flow** — modal vs. dedicated page vs. inline form. The empty state has a primary button; what it opens is an open question.
