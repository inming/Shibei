import { render, screen } from "@testing-library/react";
import { expect, test, vi } from "vitest";
import App from "./App";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn().mockResolvedValue([]),
}));

test("renders library tab and sidebar", () => {
  render(<App />);
  expect(screen.getByText("资料库")).toBeInTheDocument();
  expect(screen.getByText("文件夹")).toBeInTheDocument();
  expect(screen.getByText("标签")).toBeInTheDocument();
});
