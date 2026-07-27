import { useState } from "react";
import {
  appearanceColorTokens,
  defaultAppearanceSettings,
  defaultDarkPalette,
  defaultLightPalette,
  getContrastWarnings,
  normalizeHexColor,
  tokenLabels,
  type AppearanceColorToken,
  type AppearanceSettings,
  type ThemeMode,
} from "../../features/settings";

type EditingPalette = "light" | "dark";

type SettingsPageProps = {
  appearanceSettings: AppearanceSettings;
  onAppearanceSettingsChange: (settings: AppearanceSettings) => void;
};

export function SettingsPage({
  appearanceSettings,
  onAppearanceSettingsChange,
}: SettingsPageProps) {
  const [editingPalette, setEditingPalette] = useState<EditingPalette>(
    appearanceSettings.themeMode === "dark" ? "dark" : "light",
  );
  const [draftHexValues, setDraftHexValues] = useState<Partial<Record<EditingPalette, Partial<Record<AppearanceColorToken, string>>>>>({});
  const [showResetAllConfirmation, setShowResetAllConfirmation] = useState(false);
  const palette = editingPalette === "dark" ? appearanceSettings.darkPalette : appearanceSettings.lightPalette;
  const warnings = getContrastWarnings(palette);

  function updateSettings(next: AppearanceSettings) {
    onAppearanceSettingsChange(next);
  }

  function updatePalette(token: AppearanceColorToken, rawValue: string) {
    const normalized = normalizeHexColor(rawValue);
    setDraftHexValues((current) => ({
      ...current,
      [editingPalette]: {
        ...current[editingPalette],
        [token]: rawValue,
      },
    }));
    if (!normalized) {
      return;
    }

    const nextPalette = { ...palette, [token]: normalized };
    updateSettings({
      ...appearanceSettings,
      [editingPalette === "dark" ? "darkPalette" : "lightPalette"]: nextPalette,
    });
    setDraftHexValues((current) => ({
      ...current,
      [editingPalette]: {
        ...current[editingPalette],
        [token]: normalized,
      },
    }));
  }

  function displayValue(token: AppearanceColorToken) {
    return draftHexValues[editingPalette]?.[token] ?? palette[token];
  }

  function resetCurrentPalette() {
    updateSettings({
      ...appearanceSettings,
      [editingPalette === "dark" ? "darkPalette" : "lightPalette"]:
        editingPalette === "dark" ? defaultDarkPalette : defaultLightPalette,
    });
    setDraftHexValues((current) => ({ ...current, [editingPalette]: {} }));
  }

  function resetAllAppearance() {
    updateSettings(defaultAppearanceSettings);
    setEditingPalette("light");
    setDraftHexValues({});
    setShowResetAllConfirmation(false);
  }

  return (
    <div className="page settings-page">
      <header className="page-header">
        <p className="eyebrow">Preferences</p>
        <h1>Settings</h1>
        <p>Customize the FluorCast appearance for this device.</p>
      </header>

      <section className="appearance-layout" aria-labelledby="appearance-heading">
        <div className="appearance-editor">
          <div className="section-heading">
            <div>
              <h2 id="appearance-heading">Appearance</h2>
              <span>{editingPalette === "dark" ? "Editing dark palette" : "Editing light palette"}</span>
            </div>
          </div>

          <fieldset className="segmented-field">
            <legend>Theme mode</legend>
            <div className="segmented-control">
              {(["system", "light", "dark"] as ThemeMode[]).map((mode) => (
                <label className="segmented-option" key={mode}>
                  <input
                    checked={appearanceSettings.themeMode === mode}
                    name="theme-mode"
                    onChange={() => updateSettings({ ...appearanceSettings, themeMode: mode })}
                    type="radio"
                  />
                  <span>{mode[0].toUpperCase()}{mode.slice(1)}</span>
                </label>
              ))}
            </div>
          </fieldset>

          <fieldset className="segmented-field">
            <legend>Palette being edited</legend>
            <div className="segmented-control">
              {(["light", "dark"] as EditingPalette[]).map((mode) => (
                <label className="segmented-option" key={mode}>
                  <input
                    checked={editingPalette === mode}
                    name="editing-palette"
                    onChange={() => setEditingPalette(mode)}
                    type="radio"
                  />
                  <span>{mode[0].toUpperCase()}{mode.slice(1)} palette</span>
                </label>
              ))}
            </div>
          </fieldset>

          <div className="palette-grid">
            {appearanceColorTokens.map((token) => {
              const inputValue = displayValue(token);
              const isInvalid = normalizeHexColor(inputValue) === null;
              const inputId = `${editingPalette}-${token}-hex`;
              const labelId = `${inputId}-label`;
              const errorId = `${inputId}-error`;
              return (
                <div className="color-token-control" key={token}>
                  <span id={labelId}>{tokenLabels[token]}</span>
                  <div className="color-token-inputs">
                    <input
                      aria-label={`${tokenLabels[token]} color picker`}
                      className="color-input"
                      onChange={(event) => updatePalette(token, event.target.value)}
                      type="color"
                      value={palette[token]}
                    />
                    <input
                      aria-describedby={isInvalid ? errorId : undefined}
                      aria-invalid={isInvalid}
                      aria-labelledby={labelId}
                      id={inputId}
                      onBlur={() => {
                        const normalized = normalizeHexColor(inputValue);
                        if (normalized) updatePalette(token, normalized);
                      }}
                      onChange={(event) => updatePalette(token, event.target.value)}
                      type="text"
                      value={inputValue}
                    />
                  </div>
                  {isInvalid ? (
                    <small className="field-error" id={errorId}>Use a 6-digit hex color, like #8ab4ff.</small>
                  ) : null}
                </div>
              );
            })}
          </div>

          {warnings.length > 0 ? (
            <div className="contrast-warning-panel" role="status">
              <h3>Contrast warnings</h3>
              <ul>
                {warnings.map((warning) => (
                  <li key={warning.id}>
                    {warning.label}: {warning.ratio}:1, target {warning.required}:1
                  </li>
                ))}
              </ul>
            </div>
          ) : (
            <p className="settings-note">The current palette passes the built-in contrast checks.</p>
          )}

          <div className="form-actions">
            <span>Changes save immediately and each palette stays independent.</span>
            <div className="button-row">
              <button className="secondary-button" onClick={resetCurrentPalette} type="button">
                Restore current palette defaults
              </button>
              <button
                className="secondary-button danger-button"
                onClick={() => setShowResetAllConfirmation(true)}
                type="button"
              >
                Restore all appearance defaults
              </button>
            </div>
          </div>
        </div>

      </section>

      {showResetAllConfirmation ? (
        <div className="dialog-backdrop" role="presentation">
          <div className="confirmation-dialog" role="dialog" aria-modal="true" aria-labelledby="reset-appearance-heading">
            <h2 id="reset-appearance-heading">Restore all appearance defaults?</h2>
            <p>This replaces the selected mode and both custom palettes with FluorCast defaults.</p>
            <div className="button-row">
              <button className="secondary-button" onClick={() => setShowResetAllConfirmation(false)} type="button">
                Cancel
              </button>
              <button className="primary-button" onClick={resetAllAppearance} type="button">
                Restore defaults
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
