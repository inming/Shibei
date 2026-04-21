import { render, screen, cleanup, act, waitFor, fireEvent } from "@testing-library/react";
import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";
import { mockInvoke } from "@/test/tauriMock";
import { PairingDialog } from "./PairingDialog";

// Mock the qrcode library so tests don't render actual QR pixels.
// The library is CJS, so `import QRCode from "qrcode"` resolves to module.exports.
vi.mock("qrcode", () => {
  const toDataURL = vi.fn(async () => "data:image/png;base64,MOCK");
  return {
    default: { toDataURL },
    toDataURL,
  };
});

describe("PairingDialog", () => {
  let onClose: () => void;

  beforeEach(() => {
    onClose = vi.fn<() => void>();
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it("calls cmd_generate_pairing_payload on mount with a 6-digit PIN", async () => {
    const invoked: { cmd: string; pin: string }[] = [];
    mockInvoke((cmd, args) => {
      if (cmd === "cmd_generate_pairing_payload") {
        invoked.push({ cmd, pin: String((args as { pin?: string })?.pin ?? "") });
        return "{\"v\":1}";
      }
      return undefined;
    });

    render(<PairingDialog onClose={onClose} />);

    await waitFor(() => expect(invoked.length).toBeGreaterThan(0));
    expect(invoked[0]!.cmd).toBe("cmd_generate_pairing_payload");
    expect(invoked[0]!.pin).toMatch(/^[0-9]{6}$/);
  });

  it("renders the PIN grouped as XXX XXX and the QR image", async () => {
    mockInvoke((cmd) => (cmd === "cmd_generate_pairing_payload" ? "{\"v\":1}" : undefined));

    render(<PairingDialog onClose={onClose} />);

    await waitFor(() => expect(screen.getByTestId("pairing-qr")).toBeInTheDocument());
    const pin = screen.getByLabelText("PIN").textContent ?? "";
    expect(pin).toMatch(/^\d{3} \d{3}$/);
  });

  it("switches to expired state after 30 seconds", async () => {
    mockInvoke((cmd) => (cmd === "cmd_generate_pairing_payload" ? "{\"v\":1}" : undefined));

    render(<PairingDialog onClose={onClose} />);
    await waitFor(() => expect(screen.getByTestId("pairing-qr")).toBeInTheDocument());

    // Advance 30 seconds.
    await act(async () => {
      vi.advanceTimersByTime(30_000);
    });

    expect(screen.getAllByText("已过期").length).toBeGreaterThan(0);
  });

  it("regenerate triggers a new command invocation", async () => {
    let count = 0;
    mockInvoke((cmd) => {
      if (cmd === "cmd_generate_pairing_payload") {
        count += 1;
        return "{\"v\":1}";
      }
      return undefined;
    });

    render(<PairingDialog onClose={onClose} />);
    await waitFor(() => expect(count).toBe(1));

    fireEvent.click(screen.getByText("重新生成"));
    await waitFor(() => expect(count).toBe(2));
  });

  it("close button fires onClose", async () => {
    mockInvoke((cmd) => (cmd === "cmd_generate_pairing_payload" ? "{\"v\":1}" : undefined));

    render(<PairingDialog onClose={onClose} />);
    await waitFor(() => expect(screen.getByTestId("pairing-qr")).toBeInTheDocument());

    fireEvent.click(screen.getByText("关闭"));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("shows translated error when command rejects with i18n key", async () => {
    mockInvoke((cmd) => {
      if (cmd === "cmd_generate_pairing_payload") {
        throw { message: "error.pairingSyncNotConfigured" };
      }
      return undefined;
    });

    render(<PairingDialog onClose={onClose} />);

    // translateError looks up the i18n key in the real bundle (loaded via
    // commands.ts importing @/i18n). Assert on the translated Chinese text.
    await waitFor(() =>
      expect(screen.getByText("请先配置 S3 同步")).toBeInTheDocument()
    );
  });
});
