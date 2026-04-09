import "@testing-library/jest-dom/vitest";
import { vi, afterEach } from "vitest";
import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import { tauriCoreMock, tauriEventMock, resetInvoke, resetListeners } from "./tauriMock";

i18n.use(initReactI18next).init({
  lng: "zh",
  fallbackLng: "zh",
  resources: {},
  interpolation: { escapeValue: false },
});

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
