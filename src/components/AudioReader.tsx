import { useRef, useState, useEffect, useCallback } from "react";
import { useTranslation } from "react-i18next";
import type { Highlight, AudioAnchor } from "@/types";
import styles from "./AudioReader.module.css";

// Tauri 2 protocol URLs differ per platform (see ReaderView).
const IS_WINDOWS = navigator.userAgent.includes("Windows");
const PROTOCOL_BASE = IS_WINDOWS ? "http://shibei.localhost" : "shibei://localhost";

const SPEEDS = [0.75, 1, 1.25, 1.5, 1.75, 2];
const SKIP_SECONDS = 15;

/** A request to seek the player to a highlight's start time. `ts` forces the
 *  effect to re-fire when the same highlight is clicked twice. */
export interface AudioSeekRequest {
  id: string;
  ts: number;
}

interface AudioReaderProps {
  resourceId: string;
  highlights: Highlight[];
  activeHighlightId: string | null;
  onSelection: (info: {
    text: string;
    anchor: AudioAnchor;
    rect: { top: number; left: number; width: number; height: number };
  }) => void;
  onClearSelection: () => void;
  onHighlightClick: (id: string) => void;
  onHighlightContextMenu: (id: string, position: { top: number; left: number }) => void;
  onReady: () => void;
  seekRequest: AudioSeekRequest | null;
}

function formatTime(sec: number): string {
  const total = isFinite(sec) && sec > 0 ? Math.floor(sec) : 0;
  const s = total % 60;
  const m = Math.floor(total / 60) % 60;
  const h = Math.floor(total / 3600);
  const mm = String(m).padStart(2, "0");
  const ss = String(s).padStart(2, "0");
  return h > 0 ? `${h}:${mm}:${ss}` : `${m}:${ss}`;
}

/** Narrow a highlight's opaque anchor to an audio anchor, or null. */
function audioAnchorOf(h: Highlight): AudioAnchor | null {
  const a = h.anchor as AudioAnchor;
  return a && a.type === "audio" && typeof a.start === "number" ? a : null;
}

export function AudioReader({
  resourceId,
  highlights,
  activeHighlightId,
  onSelection,
  onClearSelection,
  onHighlightClick,
  onHighlightContextMenu,
  onReady,
  seekRequest,
}: AudioReaderProps) {
  const { t } = useTranslation("reader");
  const audioRef = useRef<HTMLAudioElement>(null);
  const markBtnRef = useRef<HTMLButtonElement>(null);
  const readyFired = useRef(false);
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [rate, setRate] = useState(1);

  const src = `${PROTOCOL_BASE}/resource/${resourceId}`;

  const seek = useCallback((time: number) => {
    const el = audioRef.current;
    if (!el) return;
    const max = isFinite(el.duration) ? el.duration : time;
    el.currentTime = Math.max(0, Math.min(time, max));
  }, []);

  // Seek on panel click / deep-link request.
  useEffect(() => {
    if (!seekRequest) return;
    const hl = highlights.find((h) => h.id === seekRequest.id);
    const anchor = hl ? audioAnchorOf(hl) : null;
    if (anchor) seek(anchor.start);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seekRequest]);

  const togglePlay = useCallback(() => {
    const el = audioRef.current;
    if (!el) return;
    if (el.paused) el.play().catch(() => {});
    else el.pause();
  }, []);

  const skip = useCallback(
    (delta: number) => {
      const el = audioRef.current;
      if (el) seek(el.currentTime + delta);
    },
    [seek],
  );

  const changeRate = useCallback((r: number) => {
    setRate(r);
    if (audioRef.current) audioRef.current.playbackRate = r;
  }, []);

  const handleSeekBar = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const v = Number(e.target.value);
      seek(v);
      setCurrentTime(v);
    },
    [seek],
  );

  const handleAddMarker = useCallback(() => {
    const el = audioRef.current;
    if (!el) return;
    const at = el.currentTime;
    const anchor: AudioAnchor = { type: "audio", start: at, end: at };
    const btn = markBtnRef.current?.getBoundingClientRect();
    const rect = btn
      ? { top: btn.bottom + 6, left: btn.left, width: 0, height: 0 }
      : { top: 120, left: 120, width: 0, height: 0 };
    onSelection({ text: formatTime(at), anchor, rect });
  }, [onSelection]);

  const markers = highlights
    .map((h) => ({ h, anchor: audioAnchorOf(h) }))
    .filter((m): m is { h: Highlight; anchor: AudioAnchor } => m.anchor !== null);

  return (
    <div className={styles.container} onClick={onClearSelection}>
      <audio
        ref={audioRef}
        src={src}
        preload="metadata"
        onLoadedMetadata={(e) => {
          const d = e.currentTarget.duration;
          setDuration(isFinite(d) ? d : 0);
          e.currentTarget.playbackRate = rate;
          if (!readyFired.current) {
            readyFired.current = true;
            onReady();
          }
        }}
        onTimeUpdate={(e) => setCurrentTime(e.currentTarget.currentTime)}
        onPlay={() => setIsPlaying(true)}
        onPause={() => setIsPlaying(false)}
        onEnded={() => setIsPlaying(false)}
      />

      <div className={styles.player} onClick={(e) => e.stopPropagation()}>
        <div className={styles.controls}>
          <button
            className={styles.skipBtn}
            onClick={() => skip(-SKIP_SECONDS)}
            title={t("audioSkipBack", { sec: SKIP_SECONDS })}
          >
            « {SKIP_SECONDS}s
          </button>
          <button
            className={styles.playBtn}
            onClick={togglePlay}
            title={isPlaying ? t("audioPause") : t("audioPlay")}
          >
            {isPlaying ? "⏸" : "▶"}
          </button>
          <button
            className={styles.skipBtn}
            onClick={() => skip(SKIP_SECONDS)}
            title={t("audioSkipForward", { sec: SKIP_SECONDS })}
          >
            {SKIP_SECONDS}s »
          </button>
        </div>

        <div className={styles.timeline}>
          <span className={styles.time}>{formatTime(currentTime)}</span>
          <div className={styles.seekWrap}>
            <input
              type="range"
              className={styles.seek}
              min={0}
              max={duration || 0}
              step={0.1}
              value={Math.min(currentTime, duration || 0)}
              onChange={handleSeekBar}
              aria-label={t("audioSeek")}
            />
            {duration > 0 &&
              markers.map(({ h, anchor }) => (
                <button
                  key={h.id}
                  className={`${styles.marker} ${activeHighlightId === h.id ? styles.markerActive : ""}`}
                  style={{
                    left: `${Math.min(100, Math.max(0, (anchor.start / duration) * 100))}%`,
                    backgroundColor: h.color,
                  }}
                  title={h.text_content || formatTime(anchor.start)}
                  onClick={(e) => {
                    e.stopPropagation();
                    seek(anchor.start);
                    onHighlightClick(h.id);
                  }}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    onHighlightContextMenu(h.id, { top: e.clientY, left: e.clientX });
                  }}
                />
              ))}
          </div>
          <span className={styles.time}>{formatTime(duration)}</span>
        </div>

        <div className={styles.bottomRow}>
          <button
            ref={markBtnRef}
            className={styles.markBtn}
            onClick={handleAddMarker}
            data-testid="audio-add-marker"
          >
            ⏱ {t("audioAddMarker")}
          </button>
          <div className={styles.speed}>
            <span className={styles.speedLabel}>{t("audioSpeed")}</span>
            {SPEEDS.map((s) => (
              <button
                key={s}
                className={`${styles.speedBtn} ${rate === s ? styles.speedBtnActive : ""}`}
                onClick={() => changeRate(s)}
              >
                {s}×
              </button>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
