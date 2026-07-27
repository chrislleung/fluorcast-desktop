import { fireEvent, render, screen, within } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import type { AppearanceSettings } from "../../features/settings";
import { defaultAppearanceSettings } from "../../features/settings";
import { SettingsPage } from "./SettingsPage";

function renderSettings(onChange = vi.fn()) {
  function Harness() {
    const [settings, setSettings] = useState<AppearanceSettings>(defaultAppearanceSettings);
    return (
      <SettingsPage
        appearanceSettings={settings}
        onAppearanceSettingsChange={(nextSettings) => {
          setSettings(nextSettings);
          onChange(nextSettings);
        }}
      />
    );
  }

  return {
    onChange,
    ...render(<Harness />),
  };
}

describe("SettingsPage", () => {
  it("renders appearance as the main settings content without a collapsed section", () => {
    const { container } = renderSettings();

    expect(screen.getByRole("heading", { name: "Settings" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Appearance" })).toBeInTheDocument();
    expect(container.querySelector("details")).not.toBeInTheDocument();
    expect(screen.queryByText("Local")).not.toBeInTheDocument();
  });

  it("updates theme mode selection", () => {
    const { onChange } = renderSettings();

    fireEvent.click(screen.getByLabelText("Dark"));

    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ themeMode: "dark" }));
  });

  it("keeps light and dark palettes independent", () => {
    const { onChange } = renderSettings();

    fireEvent.change(document.getElementById("light-primary-hex") as HTMLInputElement, { target: { value: "#123456" } });

    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({
      lightPalette: expect.objectContaining({ primary: "#123456" }),
      darkPalette: defaultAppearanceSettings.darkPalette,
    }));
  });

  it("rejects invalid hex input without emitting a corrupted setting", () => {
    const { onChange } = renderSettings();

    fireEvent.change(document.getElementById("light-primary-hex") as HTMLInputElement, { target: { value: "bad" } });

    expect(screen.getByText("Use a 6-digit hex color, like #8ab4ff.")).toBeInTheDocument();
    expect(onChange).not.toHaveBeenCalled();
  });

  it("updates the real color controls from hex input", () => {
    renderSettings();

    fireEvent.change(document.getElementById("light-primary-hex") as HTMLInputElement, { target: { value: "#123456" } });

    expect(screen.getByLabelText("Primary color picker")).toHaveValue("#123456");
    expect(document.getElementById("light-primary-hex")).toHaveValue("#123456");
  });

  it("requires confirmation before restoring all appearance defaults", () => {
    const { onChange } = renderSettings();

    fireEvent.click(screen.getByRole("button", { name: "Restore all appearance defaults" }));
    expect(screen.getByRole("dialog", { name: "Restore all appearance defaults?" })).toBeInTheDocument();

    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Restore defaults" }));

    expect(onChange).toHaveBeenCalledWith(defaultAppearanceSettings);
  });

  it("restores only the palette currently being edited", () => {
    const customSettings = {
      ...defaultAppearanceSettings,
      lightPalette: {
        ...defaultAppearanceSettings.lightPalette,
        primary: "#123456",
      },
    };
    const onChange = vi.fn();
    render(
      <SettingsPage appearanceSettings={customSettings} onAppearanceSettingsChange={onChange} />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Restore current palette defaults" }));

    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({
      lightPalette: defaultAppearanceSettings.lightPalette,
      darkPalette: defaultAppearanceSettings.darkPalette,
    }));
  });
});

