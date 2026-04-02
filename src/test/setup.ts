import "@testing-library/jest-dom/vitest";
import { vi, afterEach } from "vitest";
import { tauriCoreMock, tauriEventMock, resetInvoke, resetListeners } from "./tauriMock";

vi.mock("@tauri-apps/api/core", () => tauriCoreMock);
vi.mock("@tauri-apps/api/event", () => tauriEventMock);
vi.mock("react-hot-toast", () => ({
  default: { error: vi.fn(), success: vi.fn() },
  Toaster: () => null,
}));

afterEach(() => {
  resetInvoke();
  resetListeners();
});
