import { open } from "@tauri-apps/plugin-dialog";
import toast from "react-hot-toast";
import i18n from "@/i18n";
import * as cmd from "@/lib/commands";
import { translateError } from "@/lib/commands";

/** Audio container extensions accepted for import. Mirrors the backend
 *  `AUDIO_IMPORT_EXTENSIONS` and the `shibei://` protocol MIME table. */
const AUDIO_EXTENSIONS = [
  "mp3",
  "m4a",
  "aac",
  "mp4",
  "wav",
  "ogg",
  "oga",
  "opus",
  "flac",
  "weba",
  "webm",
];

/**
 * Open a file picker (PDF + audio) and import the selected file into the
 * target folder. Dispatches to the right import command by extension.
 */
export async function importFileToFolder(folderId: string): Promise<void> {
  try {
    const selected = await open({
      multiple: false,
      filters: [
        { name: i18n.t("importFileFilter", { ns: "reader" }), extensions: ["pdf", ...AUDIO_EXTENSIONS] },
      ],
    });
    if (!selected) return;

    const filePath = typeof selected === "string" ? selected : (selected as { path: string }).path;
    const ext = filePath.split(".").pop()?.toLowerCase() ?? "";

    if (AUDIO_EXTENSIONS.includes(ext)) {
      await cmd.importAudio(filePath, folderId);
    } else {
      await cmd.importPdf(filePath, folderId);
    }
    toast.success(i18n.t("saveSuccess", { ns: "common" }));
  } catch (err) {
    const msg = err && typeof err === "object" && "message" in err
      ? String((err as { message: string }).message)
      : String(err);
    toast.error(translateError(msg));
  }
}
