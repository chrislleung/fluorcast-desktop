import { getSetting, saveSetting } from "../../lib/db";

export const APPEARANCE_SETTINGS_KEY = "appearanceSettings";
export const LEGACY_ACCENT_COLOR_SETTING_KEY = "accentColor";
export const LEGACY_SECONDARY_COLOR_SETTING_KEY = "secondaryColor";

export const themeModes = ["system", "light", "dark"] as const;
export type ThemeMode = (typeof themeModes)[number];
export type ResolvedThemeMode = Exclude<ThemeMode, "system">;

export const appearanceColorTokens = [
  "primary",
  "secondary",
  "accent",
  "background",
  "surface",
  "surfaceElevated",
  "text",
  "textMuted",
  "border",
  "success",
  "warning",
  "error",
  "info",
  "focus",
  "selection",
] as const;

export type AppearanceColorToken = (typeof appearanceColorTokens)[number];
export type AppearancePalette = Record<AppearanceColorToken, string>;

export type AppearanceSettings = {
  themeMode: ThemeMode;
  lightPalette: AppearancePalette;
  darkPalette: AppearancePalette;
};

export const tokenLabels: Record<AppearanceColorToken, string> = {
  primary: "Primary",
  secondary: "Secondary",
  accent: "Accent",
  background: "Background",
  surface: "Surface",
  surfaceElevated: "Elevated surface",
  text: "Text",
  textMuted: "Muted text",
  border: "Border",
  success: "Success",
  warning: "Warning",
  error: "Error",
  info: "Info",
  focus: "Focus ring",
  selection: "Selection/highlight",
};

export const defaultLightPalette: AppearancePalette = {
  primary: "#315fdc",
  secondary: "#1b8f73",
  accent: "#6d4fd8",
  background: "#f6f8fb",
  surface: "#ffffff",
  surfaceElevated: "#edf2f7",
  text: "#111827",
  textMuted: "#4b5563",
  border: "#c8d2df",
  success: "#16734f",
  warning: "#8a5b00",
  error: "#b42318",
  info: "#1769aa",
  focus: "#315fdc",
  selection: "#d9e6ff",
};

export const defaultDarkPalette: AppearancePalette = {
  primary: "#8ab4ff",
  secondary: "#8ee6c8",
  accent: "#c4a7ff",
  background: "#090a0c",
  surface: "#111216",
  surfaceElevated: "#1b1e24",
  text: "#f1f3f5",
  textMuted: "#a4a8af",
  border: "#2b2e35",
  success: "#8ee6c8",
  warning: "#f3c969",
  error: "#f0a4a4",
  info: "#9fb7c8",
  focus: "#8ab4ff",
  selection: "#203a5f",
};

export const defaultAppearanceSettings: AppearanceSettings = {
  themeMode: "system",
  lightPalette: defaultLightPalette,
  darkPalette: defaultDarkPalette,
};

const hexPattern = /^#?[0-9a-fA-F]{6}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function normalizeHexColor(value: string): string | null {
  const trimmed = value.trim();
  if (!hexPattern.test(trimmed)) {
    return null;
  }
  return `#${trimmed.replace(/^#/, "").toLowerCase()}`;
}

export function normalizeThemeMode(value: unknown): ThemeMode {
  return themeModes.includes(value as ThemeMode) ? value as ThemeMode : "system";
}

export function normalizeAppearancePalette(value: unknown, defaults: AppearancePalette): AppearancePalette {
  const source = isRecord(value) ? value : {};
  return appearanceColorTokens.reduce((palette, token) => {
    const normalized = typeof source[token] === "string" ? normalizeHexColor(source[token]) : null;
    palette[token] = normalized ?? defaults[token];
    return palette;
  }, { ...defaults });
}

export function normalizeAppearanceSettings(value: unknown): AppearanceSettings {
  if (!isRecord(value)) {
    return defaultAppearanceSettings;
  }

  return {
    themeMode: normalizeThemeMode(value.themeMode),
    lightPalette: normalizeAppearancePalette(value.lightPalette, defaultLightPalette),
    darkPalette: normalizeAppearancePalette(value.darkPalette, defaultDarkPalette),
  };
}

export function mergeLegacyAppearanceColors(
  settings: AppearanceSettings,
  legacyAccent: string | null,
  legacySecondary: string | null,
): AppearanceSettings {
  const accent = legacyAccent ? normalizeHexColor(legacyAccent) : null;
  const secondary = legacySecondary ? normalizeHexColor(legacySecondary) : null;
  if (!accent && !secondary) {
    return settings;
  }

  return {
    ...settings,
    darkPalette: {
      ...settings.darkPalette,
      ...(accent ? { primary: accent, accent } : {}),
      ...(secondary ? { secondary, success: secondary } : {}),
    },
  };
}

export function trimAppearanceSettings(settings: AppearanceSettings): AppearanceSettings {
  return {
    themeMode: normalizeThemeMode(settings.themeMode),
    lightPalette: normalizeAppearancePalette(settings.lightPalette, defaultLightPalette),
    darkPalette: normalizeAppearancePalette(settings.darkPalette, defaultDarkPalette),
  };
}

export async function loadAppearanceSettings(): Promise<AppearanceSettings> {
  const [stored, legacyAccent, legacySecondary] = await Promise.all([
    getSetting(APPEARANCE_SETTINGS_KEY),
    getSetting(LEGACY_ACCENT_COLOR_SETTING_KEY),
    getSetting(LEGACY_SECONDARY_COLOR_SETTING_KEY),
  ]);

  if (!stored) {
    return mergeLegacyAppearanceColors(defaultAppearanceSettings, legacyAccent, legacySecondary);
  }

  try {
    return mergeLegacyAppearanceColors(normalizeAppearanceSettings(JSON.parse(stored)), legacyAccent, legacySecondary);
  } catch {
    return mergeLegacyAppearanceColors(defaultAppearanceSettings, legacyAccent, legacySecondary);
  }
}

export async function saveAppearanceSettings(settings: AppearanceSettings): Promise<boolean> {
  return saveSetting(APPEARANCE_SETTINGS_KEY, JSON.stringify(trimAppearanceSettings(settings)));
}

export function resolveThemeMode(themeMode: ThemeMode, systemPrefersDark: boolean): ResolvedThemeMode {
  return themeMode === "system" ? (systemPrefersDark ? "dark" : "light") : themeMode;
}

export function paletteForResolvedMode(settings: AppearanceSettings, resolvedMode: ResolvedThemeMode): AppearancePalette {
  return resolvedMode === "dark" ? settings.darkPalette : settings.lightPalette;
}

export function cssVariablesForPalette(palette: AppearancePalette): Record<string, string> {
  return {
    "--color-primary": palette.primary,
    "--color-secondary": palette.secondary,
    "--color-accent": palette.accent,
    "--color-background": palette.background,
    "--color-surface": palette.surface,
    "--color-surface-elevated": palette.surfaceElevated,
    "--color-text": palette.text,
    "--color-text-muted": palette.textMuted,
    "--color-border": palette.border,
    "--color-success": palette.success,
    "--color-warning": palette.warning,
    "--color-error": palette.error,
    "--color-info": palette.info,
    "--color-focus": palette.focus,
    "--color-selection": palette.selection,
  };
}

function hexToRgb(color: string) {
  const normalized = normalizeHexColor(color);
  if (!normalized) {
    throw new Error(`Invalid hex color: ${color}`);
  }
  const value = normalized.slice(1);
  return {
    r: Number.parseInt(value.slice(0, 2), 16) / 255,
    g: Number.parseInt(value.slice(2, 4), 16) / 255,
    b: Number.parseInt(value.slice(4, 6), 16) / 255,
  };
}

function linearize(channel: number) {
  return channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
}

export function relativeLuminance(color: string): number {
  const { r, g, b } = hexToRgb(color);
  return 0.2126 * linearize(r) + 0.7152 * linearize(g) + 0.0722 * linearize(b);
}

export function contrastRatio(foreground: string, background: string): number {
  const lighter = Math.max(relativeLuminance(foreground), relativeLuminance(background));
  const darker = Math.min(relativeLuminance(foreground), relativeLuminance(background));
  return Number(((lighter + 0.05) / (darker + 0.05)).toFixed(2));
}

export type ContrastWarning = {
  id: string;
  label: string;
  ratio: number;
  required: number;
};

export function getContrastWarnings(palette: AppearancePalette): ContrastWarning[] {
  const checks = [
    ["text-bg", "Text on background", palette.text, palette.background, 4.5],
    ["text-surface", "Text on surface", palette.text, palette.surface, 4.5],
    ["muted-bg", "Muted text on background", palette.textMuted, palette.background, 4.5],
    ["muted-surface", "Muted text on surface", palette.textMuted, palette.surface, 4.5],
    ["primary-text", "Primary button text", palette.background, palette.primary, 4.5],
    ["focus-bg", "Focus ring on background", palette.focus, palette.background, 3],
    ["focus-surface", "Focus ring on surface", palette.focus, palette.surface, 3],
    ["success-bg", "Success on background", palette.success, palette.background, 3],
    ["warning-bg", "Warning on background", palette.warning, palette.background, 3],
    ["error-bg", "Error on background", palette.error, palette.background, 3],
    ["info-bg", "Info on background", palette.info, palette.background, 3],
  ] as const;

  return checks
    .map(([id, label, foreground, background, required]) => ({
      id,
      label,
      ratio: contrastRatio(foreground, background),
      required,
    }))
    .filter((check) => check.ratio < check.required);
}

export function applyAppearanceToDocument(
  settings: AppearanceSettings,
  systemPrefersDark = typeof window !== "undefined"
    ? window.matchMedia?.("(prefers-color-scheme: dark)").matches ?? true
    : true,
) {
  if (typeof document === "undefined") {
    return;
  }
  const resolvedMode = resolveThemeMode(settings.themeMode, systemPrefersDark);
  const palette = paletteForResolvedMode(settings, resolvedMode);
  const root = document.documentElement;
  root.dataset.themeMode = settings.themeMode;
  root.dataset.resolvedTheme = resolvedMode;
  root.style.colorScheme = resolvedMode;
  Object.entries(cssVariablesForPalette(palette)).forEach(([property, value]) => {
    root.style.setProperty(property, value);
  });
}
