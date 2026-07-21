import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { HomePage } from "./HomePage";

describe("HomePage", () => {
  it("does not show NIBI login controls", () => {
    render(<HomePage />);

    expect(screen.getByRole("heading", { name: /from structure to signal/i }))
      .toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "NIBI Session" }))
      .not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Start NIBI session" }))
      .not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Test authenticated session" }))
      .not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Run remote environment checks" }))
      .not.toBeInTheDocument();
  });
});
