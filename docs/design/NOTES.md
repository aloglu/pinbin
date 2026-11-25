# Pinbin redesign: notes for implementation

`prototype.html` is the approved reference design. Open it in a browser; it is one self-contained file with sample data. It is a prototype, not production code: copy its look and behaviour, not its structure.

## What the app is for
- Inventory of electronics the owner has (the home screen).
- Planning projects: parts from the bins plus parts to buy, wiring, built-in safety checks. Projects can be tagged and archived.
- Shopping: one section per store (each store is one order), compatibility warnings for a beginner.
- Glossary of plain-language terms, linked to the owner's parts and projects.
- Bench: board pinouts, breadboard, resistor bands, multimeter dial, calculators.
- AI works through the MCP server. No AI buttons in the UI; the UI only says where the assistant can help (e.g. filling in a part's facts, photo and pinout).
- Everything the assistant can do, the owner can also do by hand (e.g. "New project" opens a blank project form).

## Owner's preferences (hard rules)
- Uses Linux and iOS. Never design only for macOS. Works on phones.
- Fonts: IBM Plex Sans / Mono by default; Instrument Sans as an option in Settings.
- Light and dark themes; dark is graphite. Accents are quiet in both.
- Not "SaaS-looking", no costume themes, no AI-isms (no lifting cards, no glow, no gradients).
- Not too small, not too big. Use space smartly.
- Playful through motion and interaction, never unpredictable.
- Clear hierarchy; distinct elements; clear next steps and consequences for add/edit/remove.
- Selected items are shown by highlight only. Never change font weight on selection.
- Iterate in small steps. Ask before changing a design direction.

## System rules from the prototype
- Controls next to each other share one height: 36px (buttons, inputs, dropdowns, segmented controls, steppers, read-only fields).
- Underline tabs: choose which slice of a page you see (inventory categories, glossary filters, active/archived, project views).
- Segmented buttons: pick a value (theme, grid/list, breadboard size, LED colour).
- Pill chips: filters you toggle on and off. Small grey tags: labels you only read.
- Lists sit on the page (no boxes), with a `--line` divider between rows. Hover is one shared tint (`color-mix(ink 7%)`) with a 6px radius and padding around the label. Dividers next to a hovered or selected row hide.
- One hover effect for all navigation (top bar, tabs, back links, side lists, quiet buttons).
- Side panels (part, shopping item) float over the page. On phones they are bottom sheets: the page behind does not scroll, tapping outside closes them. Panels open in place (e.g. from the glossary) instead of navigating away.
- Edit pages: section list on the left (desktop) or a section picker that pins under the header (phone); save bar appears only when there are unsaved changes; leave guard; Ctrl/⌘+S.
- On phones, Settings, edit pages and Bench share the same section picker. It opens as a card under the field, closes on outside tap, Esc or picking; it does not dim the page.
- Board pinouts are SVG that scale to their panel. The assistant will supply pinout SVGs; the UI only needs to frame them.
