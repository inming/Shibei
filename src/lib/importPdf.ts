import { open } from "@tauri-apps/plugin-dialog";
import toast from "react-hot-toast";
import i18n from "@/i18n";
import * as cmd from "@/lib/commands";
import { translateError } from "@/lib/commands";

/** Open file picker (filtered to .pdf) and import selected file into target folder. */
export async function importPdfToFolder(folderId: string): Promise<void> {
  try {
    const selected = await open({
      multiple: false,
      filters: [{ name: "PDF", extensions: ["pdf"] }],
    });
    if (!selected) return;

    const filePath = typeof selected === "string" ? selected : (selected as { path: string }).path;
    await cmd.importPdf(filePath, folderId);
    toast.success(i18n.t("saveSuccess", { ns: "common" }));
  } catch (err) {
    const msg = err && typeof err === "object" && "message" in err
      ? String((err as { message: string }).message)
      : String(err);
    toast.error(translateError(msg));
  }
}
