const accentPresets = [
  { name: "Blue", value: "#8ab4ff" },
  { name: "Violet", value: "#c4a7ff" },
  { name: "Amber", value: "#f3c969" },
  { name: "Rose", value: "#ff9bb3" },
  { name: "Mint", value: "#8ee6c8" },
] as const;

const secondaryPresets = [
  { name: "Mint", value: "#8ee6c8" },
  { name: "Amber", value: "#f3c969" },
  { name: "Steel", value: "#9fb7c8" },
  { name: "Coral", value: "#ffad91" },
  { name: "Lilac", value: "#d6b8ff" },
] as const;

type SettingsPageProps = {
  accentColor: string;
  onAccentColorChange: (color: string) => void;
  onSecondaryColorChange: (color: string) => void;
  secondaryColor: string;
};

export function SettingsPage({
  accentColor,
  onAccentColorChange,
  onSecondaryColorChange,
  secondaryColor,
}: SettingsPageProps) {
  return (
    <div className="page narrow-page">
      <header className="page-header">
        <p className="eyebrow">Preferences</p>
        <h1>Settings</h1>
        <p>Configure local workspace appearance preferences.</p>
      </header>

      <details className="form-card appearance-panel" aria-labelledby="appearance-heading">
        <summary className="appearance-summary">
          <span id="appearance-heading">Appearance</span>
          <span>Local</span>
        </summary>
        <label>
          <span>Accent color</span>
          <div className="accent-controls">
            <div className="accent-grid" role="group" aria-label="Accent presets">
              {accentPresets.map((preset) => (
                <button
                  aria-label={`${preset.name} accent`}
                  aria-pressed={accentColor.toLowerCase() === preset.value}
                  className="accent-swatch"
                  key={preset.value}
                  onClick={() => onAccentColorChange(preset.value)}
                  style={{ backgroundColor: preset.value }}
                  type="button"
                />
              ))}
            </div>
            <input
              aria-label="Custom accent color"
              className="color-input"
              onChange={(event) => onAccentColorChange(event.target.value)}
              type="color"
              value={accentColor}
            />
          </div>
          <small>Accent color controls primary actions, active navigation, and key highlights.</small>
        </label>

        <label>
          <span>Secondary color</span>
          <div className="accent-controls">
            <div className="accent-grid" role="group" aria-label="Secondary color presets">
              {secondaryPresets.map((preset) => (
                <button
                  aria-label={`${preset.name} secondary`}
                  aria-pressed={secondaryColor.toLowerCase() === preset.value}
                  className="accent-swatch secondary-swatch"
                  key={preset.value}
                  onClick={() => onSecondaryColorChange(preset.value)}
                  style={{ backgroundColor: preset.value }}
                  type="button"
                />
              ))}
            </div>
            <input
              aria-label="Custom secondary color"
              className="color-input"
              onChange={(event) => onSecondaryColorChange(event.target.value)}
              type="color"
              value={secondaryColor}
            />
          </div>
          <small>Secondary color supports quieter buttons, cards, badges, and helper panels.</small>
        </label>
      </details>
    </div>
  );
}
