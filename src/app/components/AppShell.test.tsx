import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { defaultNibiSettings } from "../../features/settings";
import type { NibiSettings } from "../../features/settings";
import { defaultManualMfaSessionState, type ManualMfaSessionUiState } from "../../lib/remote";
import { AppShell } from "./AppShell";

function renderShell(options: {
  isManualMfaChecking?: boolean;
  manualMfaSession?: ManualMfaSessionUiState;
  nibiSettings?: NibiSettings;
} = {}) {
  return render(
    <AppShell
      accentColor="#8ab4ff"
      currentPage="home"
      isManualMfaChecking={options.isManualMfaChecking}
      manualMfaSession={options.manualMfaSession ?? defaultManualMfaSessionState}
      nibiSettings={options.nibiSettings ?? defaultNibiSettings}
      onNavigate={() => undefined}
      secondaryColor="#8ee6c8"
    >
      <div>Shell content</div>
    </AppShell>,
  );
}

describe("AppShell NIBI connection status", () => {
  it("renders connected for an authenticated reusable Manual MFA session", () => {
    renderShell({
      manualMfaSession: {
        ...defaultManualMfaSessionState,
        status: "authenticated",
        can_run_background_commands: true,
      },
      nibiSettings: {
        ...defaultNibiSettings,
        backend_mode: "nibi",
        connection_mode: "interactive_mfa",
      },
    });

    expect(screen.getByText("NIBI connected")).toBeInTheDocument();
  });

  it("renders disconnected for an unauthenticated Manual MFA session", () => {
    renderShell({
      nibiSettings: {
        ...defaultNibiSettings,
        backend_mode: "nibi",
        connection_mode: "interactive_mfa",
      },
    });

    expect(screen.getByText("NIBI not connected")).toBeInTheDocument();
  });

  it("renders not required for mock mode", () => {
    renderShell();

    expect(screen.getByText("NIBI not required")).toBeInTheDocument();
  });

  it("renders checking while Manual MFA readiness is being tested", () => {
    renderShell({
      isManualMfaChecking: true,
      manualMfaSession: defaultManualMfaSessionState,
      nibiSettings: {
        ...defaultNibiSettings,
        backend_mode: "nibi",
        connection_mode: "interactive_mfa",
      },
    });

    expect(screen.getByText("Checking NIBI session...")).toBeInTheDocument();
  });

  it("updates when authenticated-session readiness changes", () => {
    const { rerender } = render(
      <AppShell
        accentColor="#8ab4ff"
        currentPage="jobs"
        manualMfaSession={defaultManualMfaSessionState}
        nibiSettings={{
          ...defaultNibiSettings,
          backend_mode: "nibi",
          connection_mode: "interactive_mfa",
        }}
        onNavigate={() => undefined}
        secondaryColor="#8ee6c8"
      >
        <div>Shell content</div>
      </AppShell>,
    );

    expect(screen.getByText("NIBI not connected")).toBeInTheDocument();

    rerender(
      <AppShell
        accentColor="#8ab4ff"
        currentPage="jobs"
        manualMfaSession={{
          ...defaultManualMfaSessionState,
          status: "authenticated",
          can_run_background_commands: true,
        }}
        nibiSettings={{
          ...defaultNibiSettings,
          backend_mode: "nibi",
          connection_mode: "interactive_mfa",
        }}
        onNavigate={() => undefined}
        secondaryColor="#8ee6c8"
      >
        <div>Shell content</div>
      </AppShell>,
    );

    expect(screen.getByText("NIBI connected")).toBeInTheDocument();
  });
});
