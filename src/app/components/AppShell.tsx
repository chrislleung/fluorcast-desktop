import type { CSSProperties, ReactNode } from "react";
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
  onNavigate,
  secondaryColor,
}: AppShellProps) {
  function isActivePage(page: AppPage) {
    return currentPage === page || (currentPage === "result" && page === "jobs");
  }

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
          <span className="connection"><i className="dot" /> NIBI not connected</span>
        </div>
      </aside>

      <main className="content" tabIndex={-1}>{children}</main>
    </div>
  );
}
