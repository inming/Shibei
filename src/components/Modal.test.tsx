import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";
import { Modal } from "./Modal";

describe("Modal", () => {
  let onClose: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    onClose = vi.fn();
  });

  afterEach(() => {
    cleanup();
  });

  it("renders title and children", () => {
    render(
      <Modal title="Test Title" onClose={onClose}>
        <p>Modal content</p>
      </Modal>
    );
    expect(screen.getByText("Test Title")).toBeInTheDocument();
    expect(screen.getByText("Modal content")).toBeInTheDocument();
  });

  it("calls onClose when close button clicked", () => {
    render(
      <Modal title="Test Title" onClose={onClose}>
        <p>Content</p>
      </Modal>
    );
    fireEvent.click(screen.getByRole("button"));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("calls onClose when overlay clicked", () => {
    const { container } = render(
      <Modal title="Test Title" onClose={onClose}>
        <p>Content</p>
      </Modal>
    );
    // Click the outermost overlay div
    fireEvent.click(container.firstChild as Element);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("does not call onClose when dialog body clicked", () => {
    render(
      <Modal title="Test Title" onClose={onClose}>
        <p>Body content</p>
      </Modal>
    );
    fireEvent.click(screen.getByText("Body content"));
    expect(onClose).not.toHaveBeenCalled();
  });

  it("calls onClose on Escape key", () => {
    render(
      <Modal title="Test Title" onClose={onClose}>
        <p>Content</p>
      </Modal>
    );
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
