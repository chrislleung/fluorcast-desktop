import type { CSSProperties, ReactNode } from "react";
import type { NibiSettings } from "../../features/settings";
import type { ManualMfaSessionUiState } from "../../lib/remote";
import { StatusBadge } from "./StatusBadge";

export type AppPage = "home" | "prediction" | "jobs" | "settings" | "diagnostics" | "about" | "result";

const navigation: Array<{ id: Exclude<AppPage, "result">; label: string; icon: string }> = [
  { id: "home", label: "Home", icon: "⌂" },
  { id: "prediction", label: "New Prediction", icon: "+" },
  { id: "jobs", label: "Jobs", icon: "≡" },
  { id: "settings", label: "Settings", icon: "⚙" },
  { id: "diagnostics", label: "Diagnostics", icon: "d" },
  { id: "about", label: "About", icon: "i" },
];

type AppShellProps = {
  accentColor: string;
  children: ReactNode;
  currentPage: AppPage;
  isManualMfaChecking?: boolean;
  manualMfaSession?: ManualMfaSessionUiState;
  nibiSettings: NibiSettings;
  onNavigate: (page: AppPage) => void;
  secondaryColor: string;
};

type AccentStyle = CSSProperties & {
  "--accent": string;
  "--accent-color": string;
  "--secondary": string;
  "--secondary-color": string;
};

export function AppShell({
  accentColor,
  children,
  currentPage,
  isManualMfaChecking = false,
  manualMfaSession,
  nibiSettings,
  onNavigate,
  secondaryColor,
}: AppShellProps) {
  function isActivePage(page: AppPage) {
    return currentPage === page || (currentPage === "result" && page === "jobs");
  }

  const nibiConnectionStatus = getNibiConnectionStatus({
    isManualMfaChecking,
    manualMfaSession,
    nibiSettings,
  });

  return (
    <div
      className="app-shell"
      style={{
        "--accent": accentColor,
        "--accent-color": accentColor,
        "--secondary": secondaryColor,
        "--secondary-color": secondaryColor,
      } as AccentStyle}
    >
      <aside className="sidebar">
        <div className="brand"><span className="mark">F</span><span>FluorCast</span></div>

        <nav className="side-nav" aria-label="Primary navigation">
          {navigation.map((item) => (
            <button
              type="button"
              key={item.id}
              className={isActivePage(item.id) ? "nav-item active" : "nav-item"}
              aria-current={isActivePage(item.id) ? "page" : undefined}
              onClick={() => onNavigate(item.id)}
            >
              <span className="nav-icon" aria-hidden="true">{item.icon}</span>
              {item.label}
            </button>
          ))}
        </nav>

        <div className="sidebar-footer">
          <StatusBadge>Local app</StatusBadge>
          <span
            aria-label={nibiConnectionStatus.accessibleLabel}
            className={`connection connection-${nibiConnectionStatus.state}`}
            role="status"
          >
            <i className="dot" aria-hidden="true" /> {nibiConnectionStatus.label}
          </span>
        </div>
      </aside>

      <main className="content" tabIndex={-1}>{children}</main>
    </div>
  );
}

function getNibiConnectionStatus({
  isManualMfaChecking = false,
  manualMfaSession,
  nibiSettings,
}: {
  isManualMfaChecking?: boolean;
  manualMfaSession?: ManualMfaSessionUiState;
  nibiSettings: NibiSettings;
}) {
  if (nibiSettings.connection_mode === "mock") {
    return {
      accessibleLabel: "NIBI connection status: NIBI not required in mock mode",
      label: "NIBI not required",
      state: "not-required",
    } as const;
  }

  if (nibiSettings.connection_mode === "interactive_mfa") {
    if (isManualMfaChecking) {
      return {
        accessibleLabel: "NIBI connection status: checking Manual MFA session readiness",
        label: "Checking NIBI session...",
        state: "checking",
      } as const;
    }

    if (manualMfaSession?.status === "authenticated" && manualMfaSession.can_run_background_commands) {
      return {
        accessibleLabel: "NIBI connection status: authenticated reusable Manual MFA session is ready",
        label: "NIBI connected",
        state: "connected",
      } as const;
    }
  }

  if (nibiSettings.connection_mode === "robot_automation" && nibiSettings.robot_access_verified) {
    return {
      accessibleLabel: "NIBI connection status: robot automation access is verified",
      label: "NIBI connected",
      state: "connected",
    } as const;
  }

  return {
    accessibleLabel: "NIBI connection status: no authenticated reusable NIBI session",
    label: "NIBI not connected",
    state: "disconnected",
  } as const;
}
