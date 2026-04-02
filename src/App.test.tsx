import { render, screen } from "@testing-library/react";
import { expect, test } from "vitest";
import { mockInvoke } from "@/test/tauriMock";
import App from "./App";

test("renders library tab and sidebar", () => {
  mockInvoke(() => []);
  render(<App />);
  expect(screen.getByText("资料库")).toBeInTheDocument();
  expect(screen.getByText("文件夹")).toBeInTheDocument();
  expect(screen.getByText("标签")).toBeInTheDocument();
});
