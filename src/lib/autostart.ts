import { enable, disable, isEnabled } from "@tauri-apps/plugin-autostart";

export async function getAutoLaunchEnabled(): Promise<boolean> {
  return isEnabled();
}

export async function setAutoLaunchEnabled(on: boolean): Promise<void> {
  if (on) {
    await enable();
  } else {
    await disable();
  }
}
