import { render, screen } from "@testing-library/react";
import { expect, test } from "vitest";
import App from "./App";

test("renders app title", () => {
  render(<App />);
  expect(screen.getByText(/拾贝/)).toBeInTheDocument();
});
