import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";
import { TabBar, type TabItem } from "./TabBar";

describe("TabBar", () => {
  let onSelectTab: ReturnType<typeof vi.fn>;
  let onCloseTab: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    onSelectTab = vi.fn();
    onCloseTab = vi.fn();
  });

  afterEach(() => {
    cleanup();
  });

  it("renders all tabs with labels", () => {
    const tabs: TabItem[] = [
      { id: "1", label: "Tab One", closable: false },
      { id: "2", label: "Tab Two", closable: true },
      { id: "3", label: "Tab Three", closable: false },
    ];
    render(
      <TabBar tabs={tabs} activeTabId="1" onSelectTab={onSelectTab} onCloseTab={onCloseTab} />
    );
    expect(screen.getByText("Tab One")).toBeInTheDocument();
    expect(screen.getByText("Tab Two")).toBeInTheDocument();
    expect(screen.getByText("Tab Three")).toBeInTheDocument();
  });

  it("calls onSelectTab when tab clicked", () => {
    const tabs: TabItem[] = [
      { id: "lib", label: "Library", closable: false },
      { id: "reader", label: "Reader", closable: true },
    ];
    render(
      <TabBar tabs={tabs} activeTabId="lib" onSelectTab={onSelectTab} onCloseTab={onCloseTab} />
    );
    fireEvent.click(screen.getByText("Reader"));
    expect(onSelectTab).toHaveBeenCalledTimes(1);
    expect(onSelectTab).toHaveBeenCalledWith("reader");
  });

  it("does not show close button on non-closable tabs", () => {
    const tabs: TabItem[] = [
      { id: "lib", label: "Library", closable: false },
    ];
    render(
      <TabBar tabs={tabs} activeTabId="lib" onSelectTab={onSelectTab} onCloseTab={onCloseTab} />
    );
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it("calls onCloseTab and not onSelectTab when close button clicked", () => {
    const tabs: TabItem[] = [
      { id: "reader", label: "Reader", closable: true },
    ];
    render(
      <TabBar tabs={tabs} activeTabId="reader" onSelectTab={onSelectTab} onCloseTab={onCloseTab} />
    );
    fireEvent.click(screen.getByRole("button"));
    expect(onCloseTab).toHaveBeenCalledTimes(1);
    expect(onCloseTab).toHaveBeenCalledWith("reader");
    expect(onSelectTab).not.toHaveBeenCalled();
  });
});
