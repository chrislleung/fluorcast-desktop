# FluorCast Appearance System

FluorCast uses semantic CSS custom properties for application appearance. Runtime theme values are generated from `AppearanceSettings` in `src/features/settings/appearance.ts` and applied to `document.documentElement` plus the app shell.

## Semantic Tokens

The editable palette tokens are:

`primary`, `secondary`, `accent`, `background`, `surface`, `surfaceElevated`, `text`, `textMuted`, `border`, `success`, `warning`, `error`, `info`, `focus`, and `selection`.

These map to CSS variables named `--color-primary`, `--color-secondary`, `--color-accent`, `--color-background`, `--color-surface`, `--color-surface-elevated`, `--color-text`, `--color-text-muted`, `--color-border`, `--color-success`, `--color-warning`, `--color-error`, `--color-info`, `--color-focus`, and `--color-selection`.

Use semantic variables for new UI. Avoid raw hex values except for fallback defaults, shadows, transparent overlays, and generated icon source files.

## Default Palettes

Default light and dark palettes live in `defaultLightPalette` and `defaultDarkPalette`. Both are checked by automated contrast tests. The defaults preserve FluorCast's blue/mint identity while allowing readable light and dark modes.

## Persistence

Appearance settings are stored in SQLite through the existing `settings` table under the `appearanceSettings` key:

```json
{
  "themeMode": "system",
  "lightPalette": { "primary": "#315fdc" },
  "darkPalette": { "primary": "#8ab4ff" }
}
```

Stored values are normalized on load. Invalid JSON, unknown theme modes, missing tokens, and malformed colors fall back to defaults. Legacy `accentColor` and `secondaryColor` keys are folded into the dark palette for backward compatibility.

## Startup Theme Application

`src/main.tsx` applies default appearance variables before React renders. `App` then loads persisted appearance from SQLite and reapplies the resolved palette. System mode listens to `prefers-color-scheme` and updates while the app is running without overwriting either palette.

## Adding Theme-Aware Components

Use existing classes where possible. For new CSS, consume `--color-*` variables directly and keep state meaning visible with labels, text, or icons. Use `--color-focus` for focus rings, status tokens for success/warning/error/info, and `--color-selection` for selected rows or highlighted regions.

## Logo And Icons

The canonical monochrome SVG mark is `src/assets/fluorcast-logo.svg`; React uses `src/app/components/FluorCastLogo.tsx`. The app icon source is `app-icon.svg`, which wraps the same mark for raster generation.

Regenerate Tauri raster assets with:

```powershell
.\scripts\generate-icons.ps1
```

The script runs `npm.cmd exec -- tauri icon app-icon.svg` and updates `src-tauri/icons`.

## Verification

Run:

```powershell
npm run lint
npm run typecheck
npm test
npm run build
cargo fmt --check --manifest-path src-tauri/Cargo.toml
cargo check --manifest-path src-tauri/Cargo.toml
cargo test --manifest-path src-tauri/Cargo.toml
```
