import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { SettingsPage } from "./SettingsPage";

function renderSettings() {
  return render(
    <SettingsPage
      accentColor="#8ab4ff"
      secondaryColor="#8ee6c8"
      onAccentColorChange={vi.fn()}
      onSecondaryColorChange={vi.fn()}
    />,
  );
}

describe("SettingsPage", () => {
  it("renders only unrelated appearance preferences", () => {
    renderSettings();

    expect(screen.getByRole("heading", { name: "Settings" })).toBeInTheDocument();
    expect(screen.getByText("Configure local workspace appearance preferences.")).toBeInTheDocument();
    expect(screen.getByText("Appearance")).toBeInTheDocument();
    expect(screen.getByLabelText("Custom accent color")).toBeInTheDocument();
    expect(screen.getByLabelText("Custom secondary color")).toBeInTheDocument();
  });

  it("does not render relocated NIBI connection controls or session actions", () => {
    renderSettings();

    expect(screen.queryByRole("heading", { name: "Connection Mode" })).not.toBeInTheDocument();
    expect(screen.queryByRole("radio", { name: /Mock mode/ })).not.toBeInTheDocument();
    expect(screen.queryByText("Mode-specific setup")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("NIBI username")).not.toBeInTheDocument();
    expect(screen.queryByText("SSH key")).not.toBeInTheDocument();
    expect(screen.queryByText("Remote FluorCast paths")).not.toBeInTheDocument();
    expect(screen.queryByText("FluorCast does not store your NIBI password. SSH keys remain on your computer."))
      .not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "NIBI Session" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Clean stale WSL session" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Start NIBI session" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Test authenticated session" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Run remote environment checks" })).not.toBeInTheDocument();
  });

  it("keeps appearance settings collapsible with the same controls", () => {
    const { container } = renderSettings();

    const appearancePanel = container.querySelector(".appearance-panel") as HTMLDetailsElement;
    expect(appearancePanel.open).toBe(false);

    fireEvent.click(screen.getByText("Appearance"));

    expect(appearancePanel.open).toBe(true);
    expect(within(appearancePanel).getByRole("button", { name: "Rose accent" })).toBeInTheDocument();
    expect(within(appearancePanel).getByRole("button", { name: "Amber secondary" })).toBeInTheDocument();
  });
});
